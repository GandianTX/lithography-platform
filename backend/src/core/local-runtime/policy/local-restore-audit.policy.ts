// src/core/local-runtime/policy/local-restore-audit.policy.ts

/**
 * 恢复终态事件与**任务 10 读侧契约**的对齐口径（任务 09 新计划第 06 项）。
 *
 * ## 为什么需要这一层
 *
 * 任务 10 的"关键操作记录"页把 `management_audit_event.detail` 按**固定白名单**投影：
 * `reason`／`stage`／`changedFields`／`attemptNo`／`beforeOrganizationName`／`afterOrganizationName`。
 * 恢复事件此前把 `detail` 写成 `restore_id`／`backup_id`／`reason_code`／`counts`
 * 这些**不在白名单内**的键 ⇒ 读侧全部丢弃 ⇒ 恢复记录在任务 10 页面上**读不出原因与阶段**。
 *
 * 本策略让恢复事件**按任务 10 的白名单契约写入**：
 * - `reason` ← 受控原因码（如 `RESTORE_EXECUTION_FAILED`）；
 * - `stage` ← 恢复阶段标识（大写下划线，受读侧字符集约束）；
 * - 其余键（包 ID、计数等）**不写进 detail**：恢复 ID 已在事件列 `target_id`，
 *   公司在 `organization_id`，操作者在 `actor_account_id`／`actor_admin_level`。
 *
 * 安全：`detail` 里**不出现**包正文、原件字节、文件路径、密钥、堆栈或计数明细。
 */

import {
  serializeManagementAuditDetail,
  type ManagementAuditDetailView,
} from '@core/management-audit/policy/management-audit-detail.policy';

import { DomainError, SYNC_ERROR } from '@core/common/errors/domain-error';

import { detectLocalRestoreReasonSensitiveContent } from './local-restore-reason-safety.policy';

/**
 * 恢复终态阶段。
 *
 * 受任务 10 读侧 `stage` 的**字符集与长度**约束：`^[A-Z][A-Z0-9_]{0,31}$`
 * （最多 32 个字符）——超出会被读侧**截断**，读出来的阶段名就不完整了。
 */
export const LOCAL_RESTORE_AUDIT_STAGES = {
  /** 恢复执行到达终态（成功） */
  EXECUTION_SUCCEEDED: 'RESTORE_SUCCEEDED',
  /** 恢复执行失败，且已按保护副本回滚（本机保持恢复前状态） */
  EXECUTION_ROLLED_BACK: 'RESTORE_ROLLED_BACK',
  /** 恢复执行失败，且**回滚也失败**（保留保护副本、设备继续停写停传） */
  EXECUTION_ROLLBACK_FAILED: 'RESTORE_ROLLBACK_FAILED',
  /**
   * 恢复执行失败，数据**已按保护副本回滚**，但**冻结解除失败**
   * ⇒ 设备继续停写停传，需人工处置。
   *
   * 与 `EXECUTION_ROLLED_BACK` 的差别：数据侧一样（保持恢复前状态），
   * 但**停写停传没有解除**——这是必须单独留痕的事实
   * （否则运维会以为"回滚完就没事了"，实际设备仍被冻结）。
   */
  EXECUTION_HOLD_RETAINED: 'RESTORE_HOLD_RETAINED',
  /**
   * 恢复**成功**，但**冻结解除失败** ⇒ 设备继续停写停传，需人工处置。
   *
   * 与 `EXECUTION_HOLD_RETAINED` 的差别：数据侧**不一样**——这里数据**已恢复成功**
   * （终态是成功，不回滚、不改判失败），差别只在**停写停传没有解除**。
   *
   * 为什么必须单独留痕（任务 09 独立验收 P1-3）：终态发布后不再回滚，
   * 所以"成功 ＋ 冻结未解除"是**真实且必须可见**的组合；
   * 若沿用失败阶段的同一个标识，读侧会把"成功"误读成"失败且未解冻"。
   */
  EXECUTION_SUCCEEDED_HOLD_RETAINED: 'RESTORE_SUCCEEDED_HOLD_RETAINED',
  /**
   * **恢复故障现场**的受控解冻**已执行**（管理员处置）。
   *
   * 这不是恢复自身的终态，而是**处置事实**：恢复的终态仍是它自己的事实，
   * 解冻只解除"停写停传"，**不改判**恢复结果。
   */
  INCIDENT_RELEASE_RELEASED: 'RESTORE_HOLD_FORCE_RELEASED',
  /** 恢复故障现场的受控解冻**被拒绝**（未解除任何冻结） */
  INCIDENT_RELEASE_DENIED: 'RESTORE_HOLD_FORCE_DENIED',
  /** 恢复故障现场的受控解冻**执行失败**（冻结保留） */
  INCIDENT_RELEASE_FAILED: 'RESTORE_HOLD_FORCE_FAILED',
  /** 恢复故障现场的受控解冻**无需执行**（已无活动冻结；幂等） */
  INCIDENT_RELEASE_NOT_REQUIRED: 'RESTORE_HOLD_FORCE_NOT_REQUIRED',
} as const;

export type LocalRestoreAuditStage =
  (typeof LOCAL_RESTORE_AUDIT_STAGES)[keyof typeof LOCAL_RESTORE_AUDIT_STAGES];

/**
 * 组装恢复终态事件的白名单摘要。
 *
 * @param result 真实终态（成功／失败）
 * @param stage 恢复阶段
 * @param reasonCode 受控原因码（失败时必填；成功时可不填）
 * @param operatorReason **处置人的实际操作原因**（自由文本）。
 *   仅"故障现场受控解冻成功"这一条处置事实会带上它：那是操作者真正写下的原因，
 *   必须可追溯。写入前已由上游做过去空白、长度边界与控制字符校验。
 *   与 `reasonCode` 同占 `reason` 键：**处置人原因优先**，没有时才回落到受控原因码。
 *
 * ## 写入侧的**最后一道闸**（不依赖调用方是否校验过）
 *
 * 处置原因一旦写进 `detail` 就**持久化并对有权查看该事件者可见**。
 * 因此本函数在此处**再判一次**：命中凭据／令牌 或 系统绝对路径时
 * **直接抛错**（不落库、不回显命中内容），而不是"脱敏后照常写入"——
 * 后者会让审计里的原因不再是操作者真正写下的那句话。
 * 抛错 ⇒ 调用方的写入事务整体回滚 ⇒ 冻结保持原状态。
 */
export function buildLocalRestoreAuditDetail(input: {
  result: 'SUCCEEDED' | 'FAILED';
  stage: LocalRestoreAuditStage;
  reasonCode?: string | null;
  operatorReason?: string | null;
}): ManagementAuditDetailView {
  const operatorReason =
    input.operatorReason === undefined || input.operatorReason === null
      ? undefined
      : input.operatorReason.trim();
  if (operatorReason !== undefined && operatorReason !== '') {
    if (detectLocalRestoreReasonSensitiveContent(operatorReason) !== null) {
      // 提示只给类型级说明，**不回显命中内容**
      throw new DomainError(
        SYNC_ERROR.INVALID_PARAMS,
        '处置原因包含不可入库的敏感内容（凭据／令牌或系统绝对路径），本次处置已整体回滚',
      );
    }
    return { stage: input.stage, reason: operatorReason };
  }
  const reason =
    input.reasonCode === undefined || input.reasonCode === null || input.reasonCode === ''
      ? undefined
      : input.reasonCode;
  return reason === undefined ? { stage: input.stage } : { stage: input.stage, reason };
}

/** 把白名单摘要序列化为可入库的 `detail` 文本（与任务 10 读侧共用同一套规则）。 */
export function serializeLocalRestoreAuditDetail(
  input: Parameters<typeof buildLocalRestoreAuditDetail>[0],
): string | null {
  return serializeManagementAuditDetail(buildLocalRestoreAuditDetail(input));
}
