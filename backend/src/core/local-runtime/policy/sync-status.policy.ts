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
 * 三条硬约束（不可协商）：
 * 1. **仅任务成功不等于已同步**：任务 `SUCCEEDED` 但缺少匹配的完整回执时不得判 SYNCED；
 * 2. **旧回执不对应新正文**：回执版本与当前业务版本不一致时不得判 SYNCED；
 * 3. **缺任务不推出不适用**：适用性必须来自可信的运行模式与记录事实。
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
  /** 未装配本机同步实现 */
  NOT_CONNECTED: 'NOT_CONNECTED',
  /** 身份不可信：记录与稳定键的绑定无法确认 */
  IDENTITY_UNTRUSTED: 'IDENTITY_UNTRUSTED',
  /** 版本不可信：当前业务版本无法核验（如草稿版本恒为 0 且无可信修订映射） */
  VERSION_UNTRUSTED: 'VERSION_UNTRUSTED',
  /** 适用性无法判定（既不能确认适用，也不能确认不适用） */
  APPLICABILITY_UNKNOWN: 'APPLICABILITY_UNKNOWN',
  /** 原记录账号授权失效 */
  AUTHORIZATION_INVALID: 'AUTHORIZATION_INVALID',
  /** 任务成功但缺少匹配的完整回执 */
  RECEIPT_MISSING: 'RECEIPT_MISSING',
  /** 回执版本与当前业务版本不一致（旧回执不对应新正文） */
  RECEIPT_VERSION_MISMATCH: 'RECEIPT_VERSION_MISMATCH',
  /** 回执存在但正文／原件清单／摘要不完整 */
  RECEIPT_INCOMPLETE: 'RECEIPT_INCOMPLETE',
  /** 任务状态与回执状态互相矛盾 */
  TASK_RECEIPT_INCONSISTENT: 'TASK_RECEIPT_INCONSISTENT',
  /** 当前版本存在待处理冲突 */
  CONFLICT_PENDING: 'CONFLICT_PENDING',
  /** 上传任务失败 */
  TASK_FAILED: 'TASK_FAILED',
  /** 上传任务被取消且没有成功回执 */
  TASK_CANCELLED: 'TASK_CANCELLED',
} as const;

export type SyncStatusReasonCode =
  (typeof syncStatusReasonCodeEnum)[keyof typeof syncStatusReasonCodeEnum];

/** 当前版本的业务同步任务事实（已由查询层过滤为 BUSINESS_SYNC） */
export type SyncStatusTaskFact = {
  /** local_upload_task.status */
  status: 'PENDING' | 'UPLOADING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  /** 任务登记的业务版本；null 表示旧行缺关键字段 */
  sourceVersion: number | null;
};

/** 当前版本的回执事实 */
export type SyncStatusReceiptFact = {
  /** sync_receipt.receipt_status */
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CONFLICT';
  /** sync_receipt.version_no */
  versionNo: number;
  /** sync_receipt.manifest_checksum：与应同步清单的摘要一致才算完整 */
  manifestChecksum: string | null;
  /** 正文是否完整同步 */
  bodyComplete: boolean;
  /** 有效原件清单是否完整同步 */
  originalsComplete: boolean;
};

/** 当前版本的冲突事实 */
export type SyncStatusConflictFact = {
  conflictId: string;
  /** 冲突的本地版本；null 表示历史未知 */
  localVersion: number | null;
  /** 冲突的云端版本；null 表示历史未知 */
  cloudVersion: number | null;
  /** 当前查看者是否可读取该冲突（可读 ≠ 可处理） */
  readable: boolean;
  /** 当前查看者是否可处理该冲突（写权 + 当前展示版本） */
  resolvable: boolean;
};

/** 聚合输入：全部为**已核对的事实**，本层不做任何查询或授权判定 */
export type SyncStatusFacts = {
  /** 本机是否已装配同步状态实现（07 未装配时为 false） */
  connected: boolean;
  /** 稳定身份是否可信绑定到该记录 */
  identityTrusted: boolean;
  /** 当前业务版本是否可核验 */
  versionTrusted: boolean;
  /** 该记录是否适用本机业务同步：true=适用、false=不适用、null=无法判定 */
  applicable: boolean | null;
  /** 原记录账号授权是否有效；null 表示未取得该事实 */
  authorizationValid: boolean | null;
  /** 当前版本的业务同步任务；null 表示当前版本没有任务 */
  task: SyncStatusTaskFact | null;
  /** 当前版本的回执；null 表示没有回执 */
  receipt: SyncStatusReceiptFact | null;
  /** 当前版本的待处理冲突；null 表示没有冲突 */
  conflict: SyncStatusConflictFact | null;
};

export type SyncStatusOutcome = {
  status: SyncStatus;
  reasonCode: SyncStatusReasonCode | null;
  /** 冲突标识：仅在确实存在当前版本的待处理冲突时给出 */
  conflictId: string | null;
  /** 是否具备处理该冲突的权限（可读且可处理） */
  canResolveConflict: boolean;
};

/** 状态优先级（数值越大越优先，用于冲突时的显式裁决与文档化） */
export const SYNC_STATUS_PRIORITY: readonly SyncStatus[] = [
  'NOT_CONNECTED',
  'UNKNOWN',
  'NOT_APPLICABLE',
  'NO_TASK',
  'PENDING',
  'UPLOADING',
  'FAILED',
  'SYNCED',
  'CONFLICT',
  'AUTHORIZATION_INVALID',
];

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
 * 1. 未装配实现 → `NOT_CONNECTED`（这是"未接入"事实，不是同步结果）；
 * 2. 身份或版本不可信 → `UNKNOWN`（**不得**用派生键、旧版本或 0 冒充可信事实）；
 * 3. 授权失效 → `AUTHORIZATION_INVALID`（原身份失效不得由他人接管）；
 * 4. 适用性无法判定 → `UNKNOWN`；明确不适用 → `NOT_APPLICABLE`；
 * 5. 当前版本存在待处理冲突 → `CONFLICT`（冲突优先于任务状态：它是最需要人处理的事实）；
 * 6. 当前版本无任务 → `NO_TASK`（已准确查询且适用）；
 * 7. 有任务：PENDING／UPLOADING 按任务真实状态；FAILED／CANCELLED → `FAILED`；
 * 8. 任务 `SUCCEEDED`：必须同时存在**当前版本**的 `SUCCEEDED` 回执，且摘要一致、
 *    正文与有效原件清单完整，才判 `SYNCED`；否则按缺回执／版本不符／内容不完整
 *    分别落到 `UNKNOWN`，任务与回执互相矛盾时同样落到 `UNKNOWN`。
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

  if (task.status === 'PENDING' || task.status === 'UPLOADING') {
    // 任务仍在进行：若同时存在当前版本的成功回执，属事实矛盾，不显示成功。
    if (facts.receipt !== null && facts.receipt.status === 'SUCCEEDED') {
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
  if (receipt.manifestChecksum === null || !receipt.bodyComplete || !receipt.originalsComplete) {
    return outcome('UNKNOWN', syncStatusReasonCodeEnum.RECEIPT_INCOMPLETE);
  }
  return outcome('SYNCED');
}
