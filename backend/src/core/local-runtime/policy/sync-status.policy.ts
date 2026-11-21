// src/core/local-runtime/policy/sync-status.policy.ts

/**
 * 业务同步状态聚合纯规则（任务 09 后续S1／S2，R066～R069、R090）。
 *
 * 定位：这是**展示语义**的唯一裁决点——把"任务／回执／冲突／身份／版本／授权"
 * 这些事实收敛成一个对外可展示的状态。查询层只负责取事实，页面只负责展示，
 * 两者都不自行判定"是否已同步"。
 *
 * 口径来自任务 07 对接草案 v0.1（双方尚未冻结）：
 * - `NOT_CONNECTED`：任务 07 尚未装配任务 09 的实现（默认适配器返回）；
 * - `UNKNOWN`：无法确认身份范围、映射或当前版本结果，或查询暂不可用；
 * - `NOT_APPLICABLE`：后端明确确认该记录不走本地同步（**不能**用"缺任务"推断）；
 * - `NO_TASK`：适用同步且已准确查询，但当前版本尚无任务；
 * - `PENDING`／`UPLOADING`／`FAILED`：当前版本业务任务的真实状态；
 * - `SYNCED`：当前版本存在匹配的 `SUCCEEDED` 回执，且正文与有效原件清单完整；
 * - `CONFLICT`：当前版本存在未解决的冲突。
 *
 * 四条硬约束（不可协商）：
 * 1. **仅任务成功不等于已同步**：任务 `SUCCEEDED` 但缺少匹配的完整回执时不得判 SYNCED；
 * 2. **旧回执不对应新正文**：回执版本与当前业务版本不一致时不得判 SYNCED；
 * 3. **缺任务不推出不适用**：适用性必须来自可信的运行模式与记录事实；
 * 4. **摘要必须一致**：回执摘要必须与任务登记的正文＋原件清单摘要一致，才算完整。
 *
 * 授权失效单列 `AUTHORIZATION_INVALID`：原记录账号授权失效后任务不得由他人接管
 * （R090）。该值不在 07 草案 v0.1 的枚举内，属任务 09 的显式表达；若双方最终冻结的
 * 枚举不含此值，消费侧按 `UNKNOWN` 展示并保留 `reasonCode`（降级安全，不伪造成功）。
 */

/** 对外展示状态（GraphQL 枚举对象：registerEnumType 要求键值映射） */
export const syncStatusEnum = {
  NOT_CONNECTED: 'NOT_CONNECTED',
  UNKNOWN: 'UNKNOWN',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  NO_TASK: 'NO_TASK',
  PENDING: 'PENDING',
  UPLOADING: 'UPLOADING',
  FAILED: 'FAILED',
  SYNCED: 'SYNCED',
  CONFLICT: 'CONFLICT',
  /** 任务 09 提案值：原记录账号授权失效（待与 07 冻结最终枚举） */
  AUTHORIZATION_INVALID: 'AUTHORIZATION_INVALID',
} as const;

export type SyncStatus = (typeof syncStatusEnum)[keyof typeof syncStatusEnum];

/** 与任务 07 草案 v0.1 一致的共享状态子集（双方冻结后即为正式枚举） */
export const SHARED_SYNC_STATUSES = [
  'NOT_CONNECTED',
  'UNKNOWN',
  'NOT_APPLICABLE',
  'NO_TASK',
  'PENDING',
  'UPLOADING',
  'FAILED',
  'SYNCED',
  'CONFLICT',
] as const satisfies readonly SyncStatus[];

/**
 * 安全原因码：只表达"为什么是这个状态"，不携带快照正文、回执内容、文件路径、
 * 凭据或他人草稿；面向用户展示时按码本地化。
 */
export const syncStatusReasonCodeEnum = {
  NOT_CONNECTED: 'NOT_CONNECTED',
  IDENTITY_UNTRUSTED: 'IDENTITY_UNTRUSTED',
  VERSION_UNTRUSTED: 'VERSION_UNTRUSTED',
  APPLICABILITY_UNKNOWN: 'APPLICABILITY_UNKNOWN',
  AUTHORIZATION_INVALID: 'AUTHORIZATION_INVALID',
  RECEIPT_MISSING: 'RECEIPT_MISSING',
  RECEIPT_VERSION_MISMATCH: 'RECEIPT_VERSION_MISMATCH',
  RECEIPT_INCOMPLETE: 'RECEIPT_INCOMPLETE',
  RECEIPT_SOURCE_UNCONFIRMED: 'RECEIPT_SOURCE_UNCONFIRMED',
  TASK_RECEIPT_INCONSISTENT: 'TASK_RECEIPT_INCONSISTENT',
  CONFLICT_PENDING: 'CONFLICT_PENDING',
  TASK_FAILED: 'TASK_FAILED',
  TASK_CANCELLED: 'TASK_CANCELLED',
  TASK_KIND_UNKNOWN: 'TASK_KIND_UNKNOWN',
  TASK_STATUS_UNKNOWN: 'TASK_STATUS_UNKNOWN',
  TASK_NOT_BODY: 'TASK_NOT_BODY',
} as const;

export type SyncStatusReasonCode =
  (typeof syncStatusReasonCodeEnum)[keyof typeof syncStatusReasonCodeEnum];

/** 本机已知任务状态（与 `local_upload_task.status` 的取值一致） */
export const SYNC_TASK_STATUSES = [
  'PENDING',
  'UPLOADING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;

export type SyncTaskStatus = (typeof SYNC_TASK_STATUSES)[number];

/** 正文类任务用途：只有这类任务成功才可能说明正文已同步 */
export const SYNC_BODY_ENTITY_TYPES = ['REPORT_VERSION'] as const;

/** 当前版本的业务同步任务事实（已由查询层过滤为 BUSINESS_SYNC） */
export type SyncStatusTaskFact = {
  /** local_upload_task.status；不在已知集合内时按未知处理 */
  status: SyncTaskStatus | 'UNKNOWN';
  /** 任务登记的业务版本；null 表示旧行缺关键字段 */
  sourceVersion: number | null;
  /** local_upload_task.manifest_checksum：正文与原件清单的 SHA-256 */
  manifestChecksum: string | null;
  /** local_upload_task.entity_type：正文／附件／备份清单 */
  entityType: string;
};

/** 当前版本的回执事实 */
export type SyncStatusReceiptFact = {
  /** sync_receipt.receipt_status */
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CONFLICT';
  /** sync_receipt.version_no */
  versionNo: number;
  /** sync_receipt.manifest_checksum：与任务登记摘要一致才算完整 */
  manifestChecksum: string | null;
  /** 回执来源安装标识是否可确认是本机产生的（历史回执为空 → 不可确认） */
  sourceInstallationConfirmed: boolean;
  /** 正文是否完整同步（由摘要一致性推导，不接受"状态成功即完整"的推断） */
  bodyComplete: boolean;
  /** 有效原件清单是否完整同步 */
  originalsComplete: boolean;
};

/** 当前版本的冲突事实 */
export type SyncStatusConflictFact = {
  conflictId: string;
  localVersion: number | null;
  cloudVersion: number | null;
  /** 当前查看者是否可读取该冲突（可读 ≠ 可处理） */
  readable: boolean;
  /** 当前查看者是否可处理该冲突（写权 + 当前展示版本） */
  resolvable: boolean;
};

/** 聚合输入：全部为**已核对的事实**，本层不做任何查询或授权判定 */
export type SyncStatusFacts = {
  connected: boolean;
  identityTrusted: boolean;
  versionTrusted: boolean;
  /** true=适用、false=不适用、null=无法判定 */
  applicable: boolean | null;
  /** 原记录账号授权是否有效；null 表示未取得该事实 */
  authorizationValid: boolean | null;
  task: SyncStatusTaskFact | null;
  /** 是否存在用途无法确认的历史任务（旧的 NULL task_kind） */
  legacyTaskExists: boolean;
  receipt: SyncStatusReceiptFact | null;
  conflict: SyncStatusConflictFact | null;
};

export type SyncStatusOutcome = {
  status: SyncStatus;
  reasonCode: SyncStatusReasonCode | null;
  conflictId: string | null;
  canResolveConflict: boolean;
};

function outcome(
  status: SyncStatus,
  reasonCode: SyncStatusReasonCode | null = null,
  conflict: SyncStatusConflictFact | null = null,
): SyncStatusOutcome {
  // 冲突标识只在当前查看者可读时给出：可读 ≠ 可处理，处理入口还要求写权与当前展示版本
  const conflictId = conflict !== null && conflict.readable ? conflict.conflictId : null;
  const canResolveConflict =
    conflict !== null && conflict.readable && conflict.resolvable && conflictId !== null;
  return { status, reasonCode, conflictId, canResolveConflict };
}

/**
 * 同步状态裁决（纯函数）。
 *
 * 裁决顺序（先排除"不能下结论"的情形，再看当前版本事实）：
 * 1. 未装配实现 → `NOT_CONNECTED`；
 * 2. 身份或版本不可信 → `UNKNOWN`（不得用派生键、旧版本或 0 冒充可信事实）；
 * 3. 授权失效 → `AUTHORIZATION_INVALID`（原身份失效不得由他人接管）；
 * 4. 适用性无法判定 → `UNKNOWN`；明确不适用 → `NOT_APPLICABLE`；
 * 5. 当前版本存在待处理冲突 → `CONFLICT`；
 * 6. 当前版本无任务，但存在用途无法确认的历史任务 → `UNKNOWN`（不能断言"没有任务"）；
 * 7. 当前版本无任务 → `NO_TASK`；
 * 8. 有任务：PENDING／UPLOADING 按任务真实状态；FAILED／CANCELLED → `FAILED`；
 * 9. 任务 `SUCCEEDED`：必须同时存在**当前版本**的 `SUCCEEDED` 回执，且回执摘要与任务
 *    登记的正文＋原件清单摘要一致、回执来源可确认是本机，才判 `SYNCED`。
 */
export function resolveSyncStatus(facts: SyncStatusFacts): SyncStatusOutcome {
  if (!facts.connected) {
    return outcome('NOT_CONNECTED', syncStatusReasonCodeEnum.NOT_CONNECTED);
  }

  const untrusted = resolveUntrusted(facts);
  if (untrusted !== null) {
    return untrusted;
  }

  if (facts.authorizationValid === false) {
    return outcome('AUTHORIZATION_INVALID', syncStatusReasonCodeEnum.AUTHORIZATION_INVALID);
  }

  const applicability = resolveApplicability(facts);
  if (applicability !== null) {
    return applicability;
  }

  if (facts.conflict !== null) {
    return outcome('CONFLICT', syncStatusReasonCodeEnum.CONFLICT_PENDING, facts.conflict);
  }

  if (facts.task === null) {
    // 存在用途无法确认的历史任务时不能断言"没有任务"
    if (facts.legacyTaskExists) {
      return outcome('UNKNOWN', syncStatusReasonCodeEnum.TASK_KIND_UNKNOWN);
    }
    return outcome('NO_TASK');
  }

  return resolveTaskOutcome(facts);
}

/** 身份或版本不可信：不得用派生键、旧版本或 0 冒充可信事实 */
function resolveUntrusted(facts: SyncStatusFacts): SyncStatusOutcome | null {
  if (!facts.identityTrusted) {
    return outcome('UNKNOWN', syncStatusReasonCodeEnum.IDENTITY_UNTRUSTED);
  }
  if (!facts.versionTrusted) {
    return outcome('UNKNOWN', syncStatusReasonCodeEnum.VERSION_UNTRUSTED);
  }
  return null;
}

/**
 * 公司级「正式运行模式」事实。
 *
 * 事实源：本机账号授权登记（`local_account_authorization`，本机 × 公司）。
 * 该表是"本机是否取得了该公司的有效云端授权"的权威登记，也是同机多公司配置
 * 初始化时判断"哪些公司属于本机"的依据（见 `backup-schedule.service.ts`）。
 *
 * 注意：`local_company_setting.setting_source` **不能**用作公司模式判据——
 * 同机多公司配置表里的 `LOCAL_MANUAL` 行是备份计划初始化时为"有 ACTIVE 授权的
 * 公司"自动补建的（`initializeMissingPlans`），用它判定模式会把已授权公司
 * 误判为未接入。
 */
export type SyncCompanyApplicabilityFacts = {
  /** 该公司在本机的授权行总数 */
  authorizationCount: number;
  /** 其中处于 ACTIVE 的授权行数 */
  activeAuthorizationCount: number;
};

/**
 * 公司级适用性裁决（纯函数）。
 *
 * - 存在 ACTIVE 授权行 → 公司在本机取得了有效云端授权，处于正式运行模式 → 适用；
 * - 有授权行但全部 REVOKED → 授权已撤销 → 不适用；
 * - 没有任何授权行 → **未取得该事实**（云端授权下发尚未接通）→ 未知，
 *   既不硬编码为真，也不据此断言不适用。
 */
export function resolveSyncCompanyApplicability(
  facts: SyncCompanyApplicabilityFacts,
): boolean | null {
  if (facts.activeAuthorizationCount > 0) {
    return true;
  }
  if (facts.authorizationCount > 0) {
    return false;
  }
  return null;
}

/**
 * 材料级 + 公司级适用性的合成（材料级优先）。
 *
 * - 材料级明确不适用（已下架／软删除）→ 不适用；
 * - 材料级无法判定（归属待确认等）→ 未知；
 * - 材料级适用 → 取公司级判定（适用／不适用／未知）。
 */
export function resolveSyncApplicability(
  materialApplicable: boolean | null,
  company: SyncCompanyApplicabilityFacts,
): boolean | null {
  if (materialApplicable === false) {
    return false;
  }
  if (materialApplicable === null) {
    return null;
  }
  return resolveSyncCompanyApplicability(company);
}

/** 适用性判定：无法判定 → 未知；明确不适用 → 不适用 */
function resolveApplicability(facts: SyncStatusFacts): SyncStatusOutcome | null {
  if (facts.applicable === null) {
    return outcome('UNKNOWN', syncStatusReasonCodeEnum.APPLICABILITY_UNKNOWN);
  }
  if (facts.applicable === false) {
    return outcome('NOT_APPLICABLE');
  }
  return null;
}

/** 已有任务时的裁决 */
function resolveTaskOutcome(facts: SyncStatusFacts): SyncStatusOutcome {
  const task = facts.task;
  if (task === null) {
    return outcome('NO_TASK');
  }

  if (task.status === 'UNKNOWN') {
    return outcome('UNKNOWN', syncStatusReasonCodeEnum.TASK_STATUS_UNKNOWN);
  }

  if (task.status === 'PENDING' || task.status === 'UPLOADING') {
    // 任务仍在进行：若同时存在**当前版本**的成功回执，属事实矛盾，不显示成功。
    if (
      facts.receipt !== null &&
      facts.receipt.status === 'SUCCEEDED' &&
      facts.receipt.versionNo === task.sourceVersion
    ) {
      return outcome('UNKNOWN', syncStatusReasonCodeEnum.TASK_RECEIPT_INCONSISTENT);
    }
    return outcome(task.status);
  }

  if (task.status === 'FAILED') {
    return outcome('FAILED', syncStatusReasonCodeEnum.TASK_FAILED);
  }

  if (task.status === 'CANCELLED') {
    // 仅剩取消任务：不能推断已同步
    return outcome('FAILED', syncStatusReasonCodeEnum.TASK_CANCELLED);
  }

  return resolveReceiptOutcome(facts);
}

/** 任务成功后的裁决：必须由当前版本的完整回执确认 */
function resolveReceiptOutcome(facts: SyncStatusFacts): SyncStatusOutcome {
  const receipt = facts.receipt;
  const task = facts.task;
  if (receipt === null || task === null) {
    return outcome('UNKNOWN', syncStatusReasonCodeEnum.RECEIPT_MISSING);
  }
  if (receipt.versionNo !== task.sourceVersion) {
    return outcome('UNKNOWN', syncStatusReasonCodeEnum.RECEIPT_VERSION_MISMATCH);
  }
  if (receipt.status === 'PENDING') {
    return outcome('PENDING');
  }
  if (receipt.status === 'FAILED') {
    return outcome('FAILED', syncStatusReasonCodeEnum.TASK_FAILED);
  }
  if (receipt.status === 'CONFLICT') {
    return outcome('CONFLICT', syncStatusReasonCodeEnum.CONFLICT_PENDING);
  }
  // 任务用途不是正文（仅附件等）时，不能证明正文已同步
  if (
    !SYNC_BODY_ENTITY_TYPES.includes(task.entityType as (typeof SYNC_BODY_ENTITY_TYPES)[number])
  ) {
    return outcome('UNKNOWN', syncStatusReasonCodeEnum.TASK_NOT_BODY);
  }
  // 回执来源无法确认是本机产生的（历史回执缺安装标识）时，不能作为本机已同步的证据
  if (!receipt.sourceInstallationConfirmed) {
    return outcome('UNKNOWN', syncStatusReasonCodeEnum.RECEIPT_SOURCE_UNCONFIRMED);
  }
  // 摘要必须与任务登记的正文＋原件清单摘要一致；缺摘要或不一致都不算完整
  const manifestMatched =
    receipt.manifestChecksum !== null &&
    task.manifestChecksum !== null &&
    receipt.manifestChecksum === task.manifestChecksum;
  if (!manifestMatched || !receipt.bodyComplete || !receipt.originalsComplete) {
    return outcome('UNKNOWN', syncStatusReasonCodeEnum.RECEIPT_INCOMPLETE);
  }
  return outcome('SYNCED');
}
