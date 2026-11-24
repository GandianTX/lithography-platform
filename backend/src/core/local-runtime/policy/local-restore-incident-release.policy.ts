// src/core/local-runtime/policy/local-restore-incident-release.policy.ts
//
// 恢复**故障现场**的受控解冻（管理员处置入口）——纯裁决层。
//
// ## 为什么单列一层
//
// `LocalWriteHoldService.forceReleaseForRecoveryIncident()` 只保证"解冻动作本身"
// 不错位（必须显式传入现场对应的恢复 ID，归属不一致仍然拒绝）。
// 但**谁能解冻**、**什么条件下解冻**、**解冻后留下什么事实**，必须在这里一次性
// 裁决清楚，且**默认失败关闭**：任何无法确认的前提都判"不解冻"，而不是"先解冻再说"。
//
// ## 三种现场状态（计划 05 第 1 条要求列清）
//
// 1. **安全重试恢复**：恢复仍可安全重试（运行行未终态／中断但保护副本与数据可回滚）
//    ⇒ 走既有 `executeLocalRestore` 重试收口，**不需要**强制解冻；
// 2. **受控管理员强制解除**：恢复已终态（成功但解冻失败／失败且已按保护副本回滚），
//    数据一致性可确认，但冻结还挡着业务写入 ⇒ 允许管理员在**显式确认 ＋ 原因**下解冻；
// 3. **需人工修复后解除**：恢复失败且**回滚也失败**（或中断），数据一致性无法确认
//    ⇒ **拒绝**解冻，设备继续停写停传，先人工修复数据。
//
// ## 口径来源
//
// - 任务书 R085／R086：恢复要区分"失败已回滚"与"回滚失败仍停写停传"；
// - 任务书 R083／R085：恢复不开放工程师；R081：二级管理员限本公司、一级管理员全局；
// - 任务 09 独立验收 P1（§42）：`forceReleaseForRecoveryIncident` 缺少受权限保护的入口。
//
// 全部原因码为受控标识（`^[A-Z][A-Z0-9_]{0,63}$`），不含路径／正文／凭据。
//
// ## 处置原因（管理员自由文本）的安全边界
//
// 处置原因会**原样进入持久化审计**并被任务 10 读侧投影 ⇒ 原因里写了什么，
// 谁就能看到什么。既有最小校验（去空白／长度／控制字符）挡不住凭据与系统路径，
// 因此本层额外**拒绝**可明确识别的敏感内容（详见
// `local-restore-reason-safety.policy`）：不改写、不脱敏后放行、不回显命中内容。
// 拒绝时**冻结保持原状态**（校验发生在任何解冻动作之前）。

import {
  detectLocalRestoreReasonSensitiveContent,
  type LocalRestoreReasonSensitiveKind,
} from './local-restore-reason-safety.policy';

/** 恢复故障现场解冻的受控原因码 */
export const LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES = {
  /** 操作者不是管理员（工程师／客户等一律拒绝） */
  NOT_ADMIN: 'RESTORE_INCIDENT_RELEASE_NOT_ADMIN',
  /** 未填写处置原因 */
  REASON_REQUIRED: 'RESTORE_INCIDENT_RELEASE_REASON_REQUIRED',
  /** 未做显式确认 */
  CONFIRMATION_REQUIRED: 'RESTORE_INCIDENT_RELEASE_CONFIRMATION_REQUIRED',
  /** 恢复运行不存在 */
  RESTORE_NOT_FOUND: 'RESTORE_INCIDENT_RELEASE_RESTORE_NOT_FOUND',
  /** 恢复目标安装不是本机（异机处置被拒） */
  TARGET_MISMATCH: 'RESTORE_INCIDENT_RELEASE_TARGET_MISMATCH',
  /** 操作者无权处置该公司数据区的现场 */
  ORGANIZATION_NOT_ALLOWED: 'RESTORE_INCIDENT_RELEASE_ORGANIZATION_NOT_ALLOWED',
  /** 恢复仍在运行（应当走安全重试，不得强制解冻） */
  RESTORE_RUNNING: 'RESTORE_INCIDENT_RELEASE_RESTORE_RUNNING',
  /** 当前没有活动冻结（无需解除；幂等） */
  NO_ACTIVE_HOLD: 'RESTORE_INCIDENT_RELEASE_NO_ACTIVE_HOLD',
  /** 活动冻结归属于**别的**恢复（不得一刀切解掉别人的冻结） */
  HOLD_OWNER_MISMATCH: 'RESTORE_INCIDENT_RELEASE_HOLD_OWNER_MISMATCH',
  /** 数据一致性无法确认（回滚失败／中断） */
  DATA_CONSISTENCY_UNCONFIRMED: 'RESTORE_INCIDENT_RELEASE_DATA_CONSISTENCY_UNCONFIRMED',
  /** 保护副本无法确认（已清理／不可读） */
  PROTECTION_COPY_UNCONFIRMED: 'RESTORE_INCIDENT_RELEASE_PROTECTION_COPY_UNCONFIRMED',
  /** 解冻动作执行失败 */
  RELEASE_FAILED: 'RESTORE_INCIDENT_RELEASE_RELEASE_FAILED',
  /**
   * **成功处置审计写入失败** ⇒ 本次处置整体回滚（冻结保留）。
   *
   * 解冻与成功审计已同事务 ⇒ 不再存在"冻结已解除、成功审计未提交"的路径；
   * 审计写不进去时**什么都没发生**，必须显式暴露而不是谎报成功。
   */
  AUDIT_FAILED: 'RESTORE_INCIDENT_RELEASE_AUDIT_FAILED',
} as const;

export type LocalRestoreIncidentReleaseReasonCode =
  (typeof LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES)[keyof typeof LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES];

/** 恢复运行的终态口径（与 `backup_restore_run.status` 一致） */
/**
 * 处置原因的最大长度（**码点**）。
 *
 * 与任务 10 读侧 `detail.reason` 的展示上限（200）一致 ⇒
 * "写得进去的必然读得出来"，不会出现审计里存了、页面上却被截断的错位。
 */
export const LOCAL_RESTORE_INCIDENT_RELEASE_REASON_MAX_LENGTH = 200;

/** 处置原因的校验结论 */
export type IncidentReleaseReasonVerdict =
  | { readonly ok: true; readonly reason: string }
  | {
      readonly ok: false;
      /** EMPTY 未填写／TOO_LONG 超长／CONTROL_CHARACTER 含控制字符 */
      readonly kind: 'EMPTY' | 'TOO_LONG' | 'CONTROL_CHARACTER';
    }
  | {
      readonly ok: false;
      /** SENSITIVE_CONTENT 命中凭据／令牌 或 系统绝对路径 */
      readonly kind: 'SENSITIVE_CONTENT';
      /** 敏感内容类别（**不含**命中的原文） */
      readonly sensitiveKind: LocalRestoreReasonSensitiveKind;
    };

/**
 * 处置原因的最小校验（纯函数，不做 I/O）。
 *
 * - **去首尾空白**：写入的是操作者真正表达的内容；
 * - **长度边界**：按码点计，与读侧展示上限一致；
 * - **拒绝控制字符**：控制字符会破坏审计详情的展示与日志安全（读侧只截断、不清洗）；
 * - **拒绝敏感内容**：凭据赋值／令牌、系统绝对路径一旦落库就会**持久化并对有权查看者可见**
 *   （见 `local-restore-reason-safety.policy`）。处置方式是**拒绝输入**：
 *   不改写成别的文本、不脱敏后放行、不回显命中内容。
 *
 * 失败时返回 `ok: false`：**调用方必须失败关闭**，不得静默丢弃用户填写的内容，
 * 也不得把不合规的原因改写成"看起来安全"的其它文本。
 *
 * 剩余风险：自由文本里的秘密无法被有限规则穷尽识别，本校验是**降低**风险而非杜绝。
 */
export function decideIncidentReleaseReasonVerdict(raw: string): IncidentReleaseReasonVerdict {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, kind: 'EMPTY' };
  }
  const codePoints = Array.from(trimmed);
  if (codePoints.length > LOCAL_RESTORE_INCIDENT_RELEASE_REASON_MAX_LENGTH) {
    return { ok: false, kind: 'TOO_LONG' };
  }
  if (hasControlCharacter(trimmed)) {
    return { ok: false, kind: 'CONTROL_CHARACTER' };
  }
  const sensitive = detectLocalRestoreReasonSensitiveContent(trimmed);
  if (sensitive !== null) {
    return { ok: false, kind: 'SENSITIVE_CONTENT', sensitiveKind: sensitive.kind };
  }
  return { ok: true, reason: trimmed };
}

/** 文本是否含控制字符（用码点判断，避免正则来源被 lint 误判） */
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export type RestoreIncidentReleaseStatus =
  'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';

/** 裁决所需事实（**必须**来自数据库／会话的复核结果，不接受客户端直接传入） */
export type RestoreIncidentReleaseFacts = {
  /** 操作者是否为管理员（工程师／客户一律 false） */
  readonly actorIsAdministrator: boolean;
  /**
   * 操作者被授权的公司数据区；`null` 表示一级管理员的**全局授权范围**。
   *
   * 与既有恢复链口径一致（`LocalRuntimeScopeResolver`）：一级管理员 null（全局），
   * 二级管理员为其可信公司。
   */
  readonly allowedOrganizationId: number | null;
  /** 恢复运行是否存在 */
  readonly restoreExists: boolean;
  /** 恢复运行的目标安装是否就是本机 */
  readonly installationMatches: boolean;
  /** 恢复运行归属的公司数据区 */
  readonly restoreOrganizationId: number | null;
  /** 恢复运行的最新状态 */
  readonly restoreStatus: RestoreIncidentReleaseStatus | null;
  /** 数据一致性是否可确认（已恢复成功／已按保护副本回滚） */
  readonly dataConsistencyConfirmed: boolean;
  /** 保护副本是否可确认（仍存在且未清理，或恢复已成功不再依赖它） */
  readonly protectionCopyConfirmed: boolean;
  /**
   * 该公司数据区上**归属于本次处置的恢复**的活动冻结条数。
   *
   * 只有这些才是"本次处置可以解除的冻结"。
   */
  readonly ownedHoldCount: number;
  /**
   * 同一范围内**归属于其它恢复**的活动冻结条数。
   *
   * 它们**不属于**本次处置：本次既不能解除，也不应因为它们还在就说"冻结已解除"。
   */
  readonly otherHoldCount: number;
  /**
   * 本次处置**原本持有**（事务外预检时仍处于 ACTIVE）的冻结条数。
   *
   * 用于区分两种"没有可解除的冻结"：
   * - `0` ⇒ 这次处置从来就没有归属自己的冻结（范围里有别人的）⇒ 归属不符，拒绝；
   * - `>0` ⇒ 自己的冻结**已被并发处置解除** ⇒ 无需解除（幂等），不得说成拒绝。
   */
  readonly previouslyOwnedHoldCount?: number;
  /** 是否填写了处置原因 */
  readonly reasonProvided: boolean;
  /** 是否做了显式确认 */
  readonly confirmed: boolean;
};

export type RestoreIncidentReleaseVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reasonCode: LocalRestoreIncidentReleaseReasonCode;
      readonly message: string;
    };

/**
 * 裁决"能否强制解除这次恢复留下的冻结"。
 *
 * 判定顺序按**基础性**排列：先排除"根本不该由这条路径处理"的情形，
 * 再排除"信息不足以确认"的情形，最后才看数据一致性。
 * 任何一步不满足都**拒绝**（失败关闭），不做"降级放行"。
 */
/**
 * "没有可解除的冻结"时的裁决：
 * - 自己的冻结**已被并发处置解除** ⇒ 幂等"无需解除"，不得说成归属不符；
 * - 从来没有归属自己的冻结（范围里有别人的）⇒ 归属不符，拒绝。
 */
function decideNoOwnedHoldRejection(input: {
  otherHoldCount: number;
  previouslyOwnedHoldCount: number;
}): RestoreIncidentReleaseVerdict {
  if (input.otherHoldCount === 0 || input.previouslyOwnedHoldCount > 0) {
    return {
      allowed: false,
      reasonCode: LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.NO_ACTIVE_HOLD,
      message: '当前没有活动冻结，无需解除',
    };
  }
  // 范围里有别人的冻结，但**没有**本次处置可以解除的那条
  return {
    allowed: false,
    reasonCode: LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.HOLD_OWNER_MISMATCH,
    message: '活动冻结归属于其它恢复，拒绝解除',
  };
}

export function decideRestoreIncidentReleaseVerdict(
  facts: RestoreIncidentReleaseFacts,
): RestoreIncidentReleaseVerdict {
  if (!facts.actorIsAdministrator) {
    return {
      allowed: false,
      reasonCode: LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.NOT_ADMIN,
      message: '恢复故障现场处置只开放管理员',
    };
  }
  if (!facts.reasonProvided) {
    return {
      allowed: false,
      reasonCode: LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.REASON_REQUIRED,
      message: '强制解除冻结必须填写处置原因',
    };
  }
  if (!facts.confirmed) {
    return {
      allowed: false,
      reasonCode: LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.CONFIRMATION_REQUIRED,
      message: '强制解除冻结必须显式确认',
    };
  }
  if (!facts.restoreExists) {
    return {
      allowed: false,
      reasonCode: LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.RESTORE_NOT_FOUND,
      message: '恢复运行不存在',
    };
  }
  if (!facts.installationMatches) {
    return {
      allowed: false,
      reasonCode: LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.TARGET_MISMATCH,
      message: '该恢复的目标安装不是本机，拒绝处置',
    };
  }
  if (
    facts.allowedOrganizationId !== null &&
    facts.restoreOrganizationId !== facts.allowedOrganizationId
  ) {
    return {
      allowed: false,
      reasonCode: LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.ORGANIZATION_NOT_ALLOWED,
      message: '无权处置该公司数据区的恢复现场',
    };
  }
  if (facts.restoreStatus === 'PENDING' || facts.restoreStatus === 'RUNNING') {
    return {
      allowed: false,
      reasonCode: LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.RESTORE_RUNNING,
      message: '恢复仍在运行，请先按安全重试收口，不得强制解冻',
    };
  }
  if (facts.ownedHoldCount === 0) {
    // 范围内一条"本次处置可以解除的冻结"都没有 ⇒ 交给归属口径裁决：
    // - 一条都没有 ⇒ 幂等"无需解除"（不伪装成"又解冻了一次"）；
    // - 只有别人的 ⇒ 归属不符；自己的若已被并发解除，仍按"无需解除"回报。
    return decideNoOwnedHoldRejection({
      otherHoldCount: facts.otherHoldCount,
      previouslyOwnedHoldCount: facts.previouslyOwnedHoldCount ?? 0,
    });
  }
  if (!facts.dataConsistencyConfirmed) {
    return {
      allowed: false,
      reasonCode: LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.DATA_CONSISTENCY_UNCONFIRMED,
      message: '数据一致性无法确认（回滚失败或恢复中断），须人工修复数据后再解除',
    };
  }
  if (!facts.protectionCopyConfirmed) {
    return {
      allowed: false,
      reasonCode: LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.PROTECTION_COPY_UNCONFIRMED,
      message: '保护副本无法确认，拒绝解除冻结',
    };
  }
  return { allowed: true };
}
