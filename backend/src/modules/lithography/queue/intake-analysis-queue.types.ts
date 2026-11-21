// src/modules/lithography/queue/intake-analysis-queue.types.ts

export interface IntakeAnalysisQueueEnqueueInput {
  readonly intakeId: number;
  readonly generationNo: number;
  readonly traceId: string;
}

export interface IntakeAnalysisQueueEnqueueResult {
  readonly jobId: string;
  readonly traceId: string;
}

/**
 * 状态感知补投结果：
 * - redelivered/job_missing：BullMQ 中不存在该确定性 jobId（投递失败 / 进程在 add 前退出）→ 直接补投；
 * - redelivered/job_terminal_removed：job 处于终态（completed/failed）且仍被保留 → 先移除再补投。
 *   已存在的终态 job 不会因再次 add 自动进入 waiting，不移除就永远无法恢复；
 * - in_flight：job 处于 waiting/active/delayed（等待、执行中或重试退避中）→ 不抢投；
 * - skipped/job_remove_failed：终态 job 移除失败（被锁定等）→ 本轮放弃，下轮再试。
 */
export type IntakeAnalysisRedeliverAction =
  | { readonly kind: 'redelivered'; readonly basis: 'job_missing' | 'job_terminal_removed' }
  | { readonly kind: 'in_flight' }
  | { readonly kind: 'skipped'; readonly reason: 'job_remove_failed' };
