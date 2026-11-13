// scripts/mock-v13/errors.ts

/**
 * Mock V13 数据入口的分级错误。
 *
 * 退出码固定，供薛在 A1–A6 中以退出码 + 标准输出做证据核对：
 * - 2：守卫/配置不满足，未建立任何写入；
 * - 3：目标存在异主记录，整次回滚且不覆盖；
 * - 4：写入或事务失败，未提交且已确认回滚；也可能是事务尚未开始即失败（不表示一定发生过回滚）；
 * - 5：写入后的定向校验不通过，已回滚；
 * - 6：事务已提交，但凭据/统计等收尾文件写入失败（数据不回滚）；
 * - 7：COMMIT 已发出但结果无法确认（不得声称已回滚，保留本轮文件）；
 * - 8：写入或事务失败，且 ROLLBACK 未成功确认（保留本轮文件，不得声称已回滚）。
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

/** 回滚未确认时的诊断详情：主错误与回滚错误都必须保留。 */
export interface RollbackUnconfirmedDetails {
  readonly targetDatabase: string;
  /**
   * 失败阶段：
   * - START_UNCERTAIN：startTransaction 抛错，无法确认事务是否已建立，随后回滚也失败；
   * - ROLLBACK_FAILED：事务已建立，但回滚调用失败，结果不能确认。
   */
  readonly phase: 'START_UNCERTAIN' | 'ROLLBACK_FAILED';
  readonly primaryError: Error;
  readonly rollbackError: Error;
  readonly retainedFiles: readonly string[];
}

/**
 * 写入或事务失败且 ROLLBACK 未成功确认：不得声称已回滚。
 *
 * 该结果独立于 4（已确认回滚）、6（已提交但收尾失败）与 7（COMMIT 结果未知），
 * 并保留原始失败原因、回滚错误和本轮创建的文件，供后续只读核对。
 */
export class RollbackUnconfirmedError extends Error {
  readonly exitCode = 8;
  readonly details: RollbackUnconfirmedDetails;

  constructor(details: RollbackUnconfirmedDetails) {
    super(
      `写入失败且回滚未确认（目标库=${details.targetDatabase}）：${details.primaryError.message}`,
    );
    this.name = 'RollbackUnconfirmedError';
    this.details = details;
  }
}

export function exitCodeOf(error: unknown): number {
  if (
    error instanceof GuardViolationError ||
    error instanceof MockConflictError ||
    error instanceof MockWriteError ||
    error instanceof MockVerificationError ||
    error instanceof PostCommitError ||
    error instanceof CommitOutcomeUnknownError ||
    error instanceof RollbackUnconfirmedError
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

/** 事务失败阶段：用于在退出码 4 下区分“事务未开始”和“已确认回滚”。 */
export type FailureTransactionState =
  'NOT_STARTED' | 'START_UNCERTAIN_ROLLBACK_CONFIRMED' | 'ROLLBACK_CONFIRMED';

/** 附加在原始错误上的回滚/清理诊断，避免主错误被覆盖。 */
export interface FailureDiagnostics {
  /** 仅当本次失败确实执行了 ROLLBACK 且调用成功时为 true；缺省表示未进入事务或无法确认。 */
  rollbackConfirmed?: boolean;
  /** 事务所处阶段；NOT_STARTED 时不得声称已回滚。 */
  transactionState?: FailureTransactionState;
  cleanupErrors?: readonly string[];
  retainedFiles?: readonly string[];
}

type DiagnosedError = Error & FailureDiagnostics;

export function attachFailureDiagnostics(error: unknown, diagnostics: FailureDiagnostics): void {
  if (!(error instanceof Error)) return;
  const target = error as DiagnosedError;
  if (diagnostics.rollbackConfirmed === true && target.rollbackConfirmed !== true) {
    target.rollbackConfirmed = true;
  }
  if (diagnostics.transactionState && !target.transactionState) {
    target.transactionState = diagnostics.transactionState;
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
    rollbackConfirmed: source.rollbackConfirmed,
    transactionState: source.transactionState,
    cleanupErrors: source.cleanupErrors,
    retainedFiles: source.retainedFiles,
  };
}
