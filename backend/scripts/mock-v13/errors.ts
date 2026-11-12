// scripts/mock-v13/errors.ts

/**
 * Mock V13 数据入口的分级错误。
 *
 * 退出码固定，供薛在 A1–A6 中以退出码 + 标准输出做证据核对：
 * - 2：守卫/配置不满足，未建立任何写入；
 * - 3：目标存在异主记录，整次回滚且不覆盖；
 * - 4：写入或事务失败，已回滚；
 * - 5：写入后的定向校验不通过，已回滚；
 * - 6：事务已提交，但凭据/统计等收尾文件写入失败（数据不回滚）。
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
    error instanceof PostCommitError
  ) {
    return error.exitCode;
  }
  return 4;
}
