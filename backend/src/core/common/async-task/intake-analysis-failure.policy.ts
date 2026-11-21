// src/core/common/async-task/intake-analysis-failure.policy.ts
// 首析失败语义策略（任务 03 第二段）：区分「可补投的临时故障」与「确定无法重试的永久错误」。
//
// 分类依据只有一条：补投能否让同一个意图产生新的执行结果。
// - 临时故障（transient）：进程退出、Redis/MySQL 瞬时不可用、租约有效期内被并发占用、
//   队列 job 的 payload 损坏但 jobId 仍可解析。补投会重建 payload 或等租约过期后接管，
//   因此必须保留在 housekeeping 的补投范围内，不能被提前终结。
// - 永久错误（permanent）：即使反复补投也不会产生新结果，例如尝试行状态越过状态机、
//   原稿关联的可信机型记录缺失、jobId 已不可解析。这类行必须受控终结为 failed 并带
//   `worker_permanent:` 稳定前缀，从补投扫描中排除，留待人工处置；同时不得因此推进
//   首析代次，也不得消耗客户唯一一次主动重试。
//
// 账本收尾原因（与 AI 生命周期审计的「稳定前缀 + 可读摘要」一致）：
// - worker_completed:intake_reconciled / worker_failed:intake_reconciled /
//   worker_cancelled:intake_reconciled：housekeeping 按业务真实结果收敛账本终态，
//   只用于「账本未终结」的崩溃窗口，不代表模型被重新调用。
// - worker_permanent:<code>：永久错误受控终结（需人工），不参与补投。
//
// 约束：reason 列 varchar(128)，所有取值必须在该长度内（本文件末尾有测试覆盖）。

export const INTAKE_ANALYSIS_WORKER_FAILED_PREFIX = 'worker_failed:';
export const INTAKE_ANALYSIS_WORKER_PERMANENT_PREFIX = 'worker_permanent:';

/** 账本按业务真实结果收敛（写回已完成、账本未终结的崩溃窗口） */
export const INTAKE_ANALYSIS_RECONCILE_SUCCEEDED_REASON = 'worker_completed:intake_reconciled';
export const INTAKE_ANALYSIS_RECONCILE_FAILED_REASON = 'worker_failed:intake_reconciled';
export const INTAKE_ANALYSIS_RECONCILE_CANCELLED_REASON = 'worker_cancelled:intake_reconciled';

/** jobId 不符合首析策略：无法定位业务目标，补投无意义 */
export const INTAKE_ANALYSIS_PERMANENT_UNPARSABLE_JOB_ID_REASON = `${INTAKE_ANALYSIS_WORKER_PERMANENT_PREFIX}intake_job_id_unparsable`;
/** intake RUNNING 而尝试行缺失/已终态：越过状态机，需人工修复 */
export const INTAKE_ANALYSIS_PERMANENT_ATTEMPT_INCONSISTENT_REASON = `${INTAKE_ANALYSIS_WORKER_PERMANENT_PREFIX}intake_attempt_state_inconsistent`;

/**
 * 不可重试错误码 → 账本受控终结。
 * 只收录「补投不可能产生新结果」的码：
 * - JOB_MISMATCH / JOB_NAME_UNKNOWN 不在此列 —— 补投会用解析出的 jobId 重建 payload，
 *   可以自愈，按临时故障处理；
 * - LEASE_ACTIVE 不在此列 —— 租约持有者可能仍在执行并写回结果，提前终结会把成功
 *   伪装成永久失败；
 * - NOT_EXECUTABLE 不在此列 —— 删除 / 代次切换 / 未关联工单由就绪度判定转为取消，
 *   取消比「永久失败」更贴近事实。
 */
const PERMANENT_NON_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'INTAKE_ANALYSIS_ATTEMPT_STATE_INCONSISTENT',
  'INTAKE_ANALYSIS_ORIGINAL_NOT_FOUND',
  'INTAKE_ANALYSIS_ALREADY_FAILED',
]);

/** 账本终态原因最大长度（base_async_task_record.reason varchar(128)） */
export const INTAKE_ANALYSIS_FAILURE_REASON_MAX_LENGTH = 128;
const FAILURE_SUMMARY_MAX_LENGTH = 96;

export function isPermanentIntakeAnalysisFailureCode(code: string | null | undefined): boolean {
  if (!code) {
    return false;
  }
  return PERMANENT_NON_RETRYABLE_CODES.has(code.trim());
}

/** 账本是否已被受控终结为需要人工处置的永久错误 */
export function isPermanentIntakeAnalysisFailureReason(reason: string | null | undefined): boolean {
  if (!reason) {
    return false;
  }
  return reason.startsWith(INTAKE_ANALYSIS_WORKER_PERMANENT_PREFIX);
}

/** 账本是否已按业务真实结果收敛（无需再次扫描） */
export function isReconciledIntakeAnalysisReason(reason: string | null | undefined): boolean {
  if (!reason) {
    return false;
  }
  return (
    reason === INTAKE_ANALYSIS_RECONCILE_SUCCEEDED_REASON ||
    reason === INTAKE_ANALYSIS_RECONCILE_FAILED_REASON ||
    reason === INTAKE_ANALYSIS_RECONCILE_CANCELLED_REASON
  );
}

/**
 * 构造 worker 失败账本原因。
 * permanent：受控终结（`worker_permanent:<code>`），从补投扫描中排除；
 * transient：保留 `worker_failed:<summary>`，仍可被 housekeeping 补投。
 */
export function buildIntakeAnalysisFailureReason(input: {
  readonly nonRetryableCode?: string | null;
  readonly summary?: string | null;
}): string {
  const code = input.nonRetryableCode?.trim();
  if (code && isPermanentIntakeAnalysisFailureCode(code)) {
    return clampReason(`${INTAKE_ANALYSIS_WORKER_PERMANENT_PREFIX}${code}`);
  }
  const summary = (input.summary ?? '').trim() || 'intake_analysis_unknown_error';
  return clampReason(
    `${INTAKE_ANALYSIS_WORKER_FAILED_PREFIX}${summary.slice(0, FAILURE_SUMMARY_MAX_LENGTH)}`,
  );
}

function clampReason(reason: string): string {
  return reason.slice(0, INTAKE_ANALYSIS_FAILURE_REASON_MAX_LENGTH);
}
