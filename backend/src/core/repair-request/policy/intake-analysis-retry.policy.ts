// src/core/repair-request/policy/intake-analysis-retry.policy.ts
// 首析自助资格策略（任务 03 第三段）：纯函数、无 I/O、无框架依赖。
//
// 产品裁决「有限自助重试」：
// - 正常排队 / 运行中 / 后台仍会补投 → 不开放客户恢复；
// - 第 0 代已形成明确的模型分析失败 → 保留 0→1 的唯一一次普通重试；
// - 后台故障且可安全恢复（只恢复当前代次、不扣普通重试机会）→ 需要原子记录
//   「本代次接受过一次客户恢复」且该记录在 Worker 写回与进程重启后仍然有效。
//   现有结构不提供该记录位：`repair_request_intake` 只有 analysis_status /
//   analysis_generation，`intake_analysis_attempt` 唯一键为
//   (intake_id, generation_no)，账本 `base_async_task_record` 唯一键为
//   (queue_name, job_id)，同一代次的 jobId 与账本行已被首次投递占用。
//   因此同代次恢复一律不开放（判定为不可用），不新增迁移、不依赖内存计数、
//   前端防抖或会被覆盖的 reason；
// - 缺少可信账本、归属冲突、尝试行缺失或状态矛盾、代次越界 → 暂不可用（失败关闭）。
//
// 判据只使用可持久化事实的形状（归属、代次、当前代次尝试行状态、受控失败原因
// 是否存在、投递意图账本行是否存在）。绝不依据账本 failed / worker_permanent:
// 前缀放行，也不把失败原因解析成业务结论。

/** 未关联原稿（旧工单没有首析语义） */
export const INTAKE_ANALYSIS_RETRY_REASON_NO_INTAKE = 'NO_INTAKE';
/** 原稿已逻辑删除 */
export const INTAKE_ANALYSIS_RETRY_REASON_INTAKE_DELETED = 'INTAKE_DELETED';
/** 原稿归属与工单/会话不一致（归属冲突，不可自助） */
export const INTAKE_ANALYSIS_RETRY_REASON_OWNERSHIP_CONFLICT = 'OWNERSHIP_CONFLICT';
/** 原稿未关联到当前工单（结构异常） */
export const INTAKE_ANALYSIS_RETRY_REASON_NOT_CONVERTED = 'NOT_CONVERTED';
/** 首析已成功，无需重试 */
export const INTAKE_ANALYSIS_RETRY_REASON_ANALYSIS_SUCCEEDED = 'ANALYSIS_SUCCEEDED';
/** 排队中或运行中（后台仍会补投），客户不介入 */
export const INTAKE_ANALYSIS_RETRY_REASON_ANALYSIS_IN_PROGRESS = 'ANALYSIS_IN_PROGRESS';
/** 第 0 代失败且具备唯一一次普通重试 */
export const INTAKE_ANALYSIS_RETRY_REASON_OWNER_RETRY_AVAILABLE = 'OWNER_RETRY_AVAILABLE';
/** 唯一一次普通重试已用掉（代次 1 再次失败不可进入第 2 代） */
export const INTAKE_ANALYSIS_RETRY_REASON_RETRY_ALREADY_USED = 'RETRY_ALREADY_USED';
/** 缺少当前代次的可信尝试结果（缺失或状态矛盾），失败不可确认 */
export const INTAKE_ANALYSIS_RETRY_REASON_FAILURE_NOT_CONFIRMED = 'FAILURE_NOT_CONFIRMED';
/** 缺少当前代次的投递意图账本行（无账本记录，不可信） */
export const INTAKE_ANALYSIS_RETRY_REASON_LEDGER_INTENT_MISSING = 'LEDGER_INTENT_MISSING';
/** WAITING 且无账本记录：从未发起过分析（如开发 Seed 样例），中性展示，不视为系统故障 */
export const INTAKE_ANALYSIS_RETRY_REASON_ANALYSIS_NOT_INITIATED = 'ANALYSIS_NOT_INITIATED';
/** 持久化状态落在受控值域之外 */
export const INTAKE_ANALYSIS_RETRY_REASON_STATUS_UNKNOWN = 'STATUS_UNKNOWN';

export type IntakeAnalysisRetryReason =
  | typeof INTAKE_ANALYSIS_RETRY_REASON_NO_INTAKE
  | typeof INTAKE_ANALYSIS_RETRY_REASON_INTAKE_DELETED
  | typeof INTAKE_ANALYSIS_RETRY_REASON_OWNERSHIP_CONFLICT
  | typeof INTAKE_ANALYSIS_RETRY_REASON_NOT_CONVERTED
  | typeof INTAKE_ANALYSIS_RETRY_REASON_ANALYSIS_SUCCEEDED
  | typeof INTAKE_ANALYSIS_RETRY_REASON_ANALYSIS_IN_PROGRESS
  | typeof INTAKE_ANALYSIS_RETRY_REASON_OWNER_RETRY_AVAILABLE
  | typeof INTAKE_ANALYSIS_RETRY_REASON_RETRY_ALREADY_USED
  | typeof INTAKE_ANALYSIS_RETRY_REASON_FAILURE_NOT_CONFIRMED
  | typeof INTAKE_ANALYSIS_RETRY_REASON_LEDGER_INTENT_MISSING
  | typeof INTAKE_ANALYSIS_RETRY_REASON_ANALYSIS_NOT_INITIATED
  | typeof INTAKE_ANALYSIS_RETRY_REASON_STATUS_UNKNOWN;

/**
 * 详情页首析展示状态（服务端判定，前端不再自行组合 FAILED + generation）：
 * - QUEUED：已登记投递意图，等待 Worker 执行；
 * - RUNNING：执行中（后台会继续处理，客户不介入）；
 * - COMPLETED：已有真实模型输出；
 * - FAILED_RETRYABLE：第 0 代明确失败且仍保留唯一一次普通重试；
 * - FAILED_NOT_RETRYABLE：失败已确认，但自助重试不可用（已用掉机会/缺可信账本）；
 * - NOT_STARTED：从未发起过分析（WAITING 且无投递意图账本行，如开发 Seed 样例），
 *   中性展示，不视为系统故障，不自动入队、不开放重试；
 * - UNAVAILABLE：缺少可信记录、归属或状态矛盾，无法判定（不自动入队）。
 */
export type IntakeAnalysisDisplayState =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_NOT_RETRYABLE'
  | 'NOT_STARTED'
  | 'UNAVAILABLE';

/** 判定输入：只允许可持久化事实，禁止运行期计数或前端状态 */
export type IntakeAnalysisRetryFacts = {
  /** 当前工单主键 */
  readonly requestId: number;
  /** 会话客户账号（本人核权） */
  readonly viewerCustomerAccountId: number;
  /** 工单归属客户账号 */
  readonly requestCustomerAccountId: number;
  /** 原稿行是否存在 */
  readonly intakeExists: boolean;
  /** 原稿归属客户账号（原稿缺失时为 null） */
  readonly intakeCustomerAccountId: number | null;
  /** 原稿是否已逻辑删除 */
  readonly intakeDeleted: boolean;
  /** 原稿转换出的工单主键 */
  readonly convertedRequestId: number | null;
  /** 当前代次（0=初次；1=唯一重试） */
  readonly generation: number;
  /** 原稿首析状态（持久化值） */
  readonly status: string;
  /** 当前代次尝试行的代次（缺失为 null） */
  readonly attemptGenerationNo: number | null;
  /** 当前代次尝试行状态（缺失为 null） */
  readonly attemptStatus: string | null;
  /** 当前代次尝试行是否记录了受控失败原因 */
  readonly attemptFailureReasonRecorded: boolean;
  /** 当前代次的投递意图账本行是否存在 */
  readonly ledgerIntentPresent: boolean;
};

export type IntakeAnalysisRetryDecision = {
  readonly eligible: boolean;
  readonly reason: IntakeAnalysisRetryReason;
  readonly displayState: IntakeAnalysisDisplayState;
};

const WAITING = 'WAITING';
const RUNNING = 'RUNNING';
const SUCCEEDED = 'SUCCEEDED';
const FAILED = 'FAILED';
const ATTEMPT_FAILED = 'FAILED';

/**
 * 解析首析的展示状态与自助重试资格（失败关闭）。
 *
 * 顺序：先排除不可信记录（缺失/删除/归属冲突/未转换），再按持久化状态判定；
 * 只有「第 0 代 + 原稿 FAILED + 同代次尝试行 FAILED 且记录了受控失败原因 +
 * 投递意图账本行存在」才开放唯一一次普通重试。
 */
export function resolveIntakeAnalysisRetryDecision(
  facts: IntakeAnalysisRetryFacts,
): IntakeAnalysisRetryDecision {
  if (!facts.intakeExists) {
    return deny(INTAKE_ANALYSIS_RETRY_REASON_NO_INTAKE, 'UNAVAILABLE');
  }
  if (facts.intakeDeleted) {
    return deny(INTAKE_ANALYSIS_RETRY_REASON_INTAKE_DELETED, 'UNAVAILABLE');
  }
  if (
    facts.intakeCustomerAccountId === null ||
    facts.intakeCustomerAccountId !== facts.requestCustomerAccountId ||
    facts.requestCustomerAccountId !== facts.viewerCustomerAccountId
  ) {
    return deny(INTAKE_ANALYSIS_RETRY_REASON_OWNERSHIP_CONFLICT, 'UNAVAILABLE');
  }
  if (facts.convertedRequestId === null || facts.convertedRequestId !== facts.requestId) {
    return deny(INTAKE_ANALYSIS_RETRY_REASON_NOT_CONVERTED, 'UNAVAILABLE');
  }

  switch (facts.status) {
    case SUCCEEDED:
      return deny(INTAKE_ANALYSIS_RETRY_REASON_ANALYSIS_SUCCEEDED, 'COMPLETED');
    case WAITING:
      return facts.ledgerIntentPresent
        ? deny(INTAKE_ANALYSIS_RETRY_REASON_ANALYSIS_IN_PROGRESS, 'QUEUED')
        : deny(INTAKE_ANALYSIS_RETRY_REASON_ANALYSIS_NOT_INITIATED, 'NOT_STARTED');
    case RUNNING:
      return facts.ledgerIntentPresent
        ? deny(INTAKE_ANALYSIS_RETRY_REASON_ANALYSIS_IN_PROGRESS, 'RUNNING')
        : deny(INTAKE_ANALYSIS_RETRY_REASON_LEDGER_INTENT_MISSING, 'UNAVAILABLE');
    case FAILED:
      return resolveFailedGeneration(facts);
    default:
      return deny(INTAKE_ANALYSIS_RETRY_REASON_STATUS_UNKNOWN, 'UNAVAILABLE');
  }
}

function resolveFailedGeneration(facts: IntakeAnalysisRetryFacts): IntakeAnalysisRetryDecision {
  if (facts.generation === 1) {
    // 唯一一次普通重试已用掉；再次失败不可进入第 2 代
    return deny(INTAKE_ANALYSIS_RETRY_REASON_RETRY_ALREADY_USED, 'FAILED_NOT_RETRYABLE');
  }
  if (facts.generation !== 0) {
    return deny(INTAKE_ANALYSIS_RETRY_REASON_STATUS_UNKNOWN, 'UNAVAILABLE');
  }
  // 失败必须以实际分析结果为准：同一代次的尝试行必须存在且仍是 FAILED，
  // 并有受控失败原因；不依据账本 failed / worker_permanent: 前缀判断
  if (
    facts.attemptGenerationNo !== facts.generation ||
    facts.attemptStatus !== ATTEMPT_FAILED ||
    !facts.attemptFailureReasonRecorded
  ) {
    return deny(INTAKE_ANALYSIS_RETRY_REASON_FAILURE_NOT_CONFIRMED, 'UNAVAILABLE');
  }
  if (!facts.ledgerIntentPresent) {
    return deny(INTAKE_ANALYSIS_RETRY_REASON_LEDGER_INTENT_MISSING, 'FAILED_NOT_RETRYABLE');
  }
  return {
    eligible: true,
    reason: INTAKE_ANALYSIS_RETRY_REASON_OWNER_RETRY_AVAILABLE,
    displayState: 'FAILED_RETRYABLE',
  };
}

function deny(
  reason: IntakeAnalysisRetryReason,
  displayState: IntakeAnalysisDisplayState,
): IntakeAnalysisRetryDecision {
  return { eligible: false, reason, displayState };
}
