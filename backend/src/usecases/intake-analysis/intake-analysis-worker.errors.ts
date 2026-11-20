// src/usecases/intake-analysis/intake-analysis-worker.errors.ts
// 首析 Worker 的不可重试错误：Adapter 将其映射为 BullMQ UnrecoverableError，
// 终止本 job 的基建重试；intake 状态的推进只发生在认领与写回路径。

export class IntakeAnalysisNonRetryableError extends Error {
  constructor(
    readonly reason: string,
    readonly code: string,
  ) {
    super(reason);
    this.name = 'IntakeAnalysisNonRetryableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isIntakeAnalysisNonRetryableError(
  error: unknown,
): error is IntakeAnalysisNonRetryableError {
  return error instanceof IntakeAnalysisNonRetryableError;
}
