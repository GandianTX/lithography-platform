// scripts/mock-v13/errors.ts

/**
 * Mock V13 数据入口的分级错误。
 *
 * 退出码固定，供薛在 A1–A6 中以退出码 + 标准输出做证据核对：
 * - 2：守卫/配置不满足，未建立任何写入；
 * - 3：目标存在异主记录，整次回滚且不覆盖；
 * - 4：写入或事务失败，已回滚；
 * - 5：写入后的定向校验不通过，已回滚；
 * - 6：事务已提交，但凭据/统计等收尾文件写入失败（数据不回滚）；
 * - 7：COMMIT 已发出但结果无法确认（不得声称已回滚，保留本轮文件）。
 */
export class GuardViolationError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = 'GuardViolationError';
  }
}

export class MockConflictError extends Error {
  readonly exitCode = 3;

  constructor(message: string) {
    super(message);
    this.name = 'MockConflictError';
  }
}

export class MockWriteError extends Error {
  readonly exitCode = 4;

  constructor(message: string) {
    super(message);
    this.name = 'MockWriteError';
  }
}

export class MockVerificationError extends Error {
  readonly exitCode = 5;

  constructor(message: string) {
    super(message);
    this.name = 'MockVerificationError';
  }
}

/** 事务已提交后的收尾失败：数据仍在，禁止据此声称“已回滚”。 */
export class PostCommitError extends Error {
  readonly exitCode = 6;

  constructor(message: string) {
    super(message);
    this.name = 'PostCommitError';
  }
}

export function exitCodeOf(error: unknown): number {
  if (
    error instanceof GuardViolationError ||
    error instanceof MockConflictError ||
    error instanceof MockWriteError ||
    error instanceof MockVerificationError ||
    error instanceof PostCommitError ||
    error instanceof CommitOutcomeUnknownError
  ) {
    return error.exitCode;
  }
  return 4;
}

/** COMMIT 已发出但结果无法确认时的诊断详情。 */
export interface CommitOutcomeDetails {
  readonly targetDatabase: string;
  /** 失败阶段：COMMIT_SENT 表示 COMMIT 调用已发起，不能据此断言未提交。 */
  readonly phase: 'COMMIT_SENT';
  readonly retainedFiles: readonly string[];
  readonly primaryError: Error;
  readonly rollbackError: Error | null;
}

/**
 * 提交结果未知：COMMIT 已发出但响应丢失/抛错。
 *
 * 此时 ROLLBACK 成功也不能证明先前未提交，因此必须保留本轮创建的文件，
 * 并输出目标库、执行阶段、保留文件与只读核对提示；不得以退出码 6 表达。
 */
export class CommitOutcomeUnknownError extends Error {
  readonly exitCode = 7;
  readonly details: CommitOutcomeDetails;

  constructor(details: CommitOutcomeDetails) {
    super(`提交结果未知（目标库=${details.targetDatabase}，阶段=${details.phase}）`);
    this.name = 'CommitOutcomeUnknownError';
    this.details = details;
  }
}

/** 附加在原始错误上的回滚/清理诊断，避免主错误被覆盖。 */
export interface FailureDiagnostics {
  rollbackError?: Error;
  /** 仅当本次失败确实执行了 ROLLBACK 且调用成功时为 true；缺省表示未进入事务或无法确认。 */
  rollbackConfirmed?: boolean;
  cleanupErrors?: readonly string[];
  retainedFiles?: readonly string[];
}

type DiagnosedError = Error & FailureDiagnostics;

export function attachFailureDiagnostics(error: unknown, diagnostics: FailureDiagnostics): void {
  if (!(error instanceof Error)) return;
  const target = error as DiagnosedError;
  if (diagnostics.rollbackError && !target.rollbackError) {
    target.rollbackError = diagnostics.rollbackError;
  }
  if (diagnostics.rollbackConfirmed === true && target.rollbackConfirmed !== true) {
    target.rollbackConfirmed = true;
  }
  if (diagnostics.cleanupErrors && !target.cleanupErrors) {
    target.cleanupErrors = diagnostics.cleanupErrors;
  }
  if (diagnostics.retainedFiles && !target.retainedFiles) {
    target.retainedFiles = diagnostics.retainedFiles;
  }
}

export function failureDiagnosticsOf(error: unknown): FailureDiagnostics {
  if (!(error instanceof Error)) return {};
  const source = error as DiagnosedError;
  return {
    rollbackError: source.rollbackError,
    rollbackConfirmed: source.rollbackConfirmed,
    cleanupErrors: source.cleanupErrors,
    retainedFiles: source.retainedFiles,
  };
}
