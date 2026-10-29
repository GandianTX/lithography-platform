// src/modules/lithography/database-error.helpers.ts
// MySQL 驱动错误识别：供业务写服务把冲突映射为领域错误，不泄露数据库细节。

/**
 * 判断是否为唯一键冲突（MySQL `ER_DUP_ENTRY` / errno 1062）。
 * TypeORM/驱动可能多层包装原始错误，故沿 `driverError` 与 `cause` 逐层识别。
 */
export function isDuplicateKeyError(error: unknown, depth = 0): boolean {
  if (typeof error !== 'object' || error === null || depth > 3) return false;
  const candidate = error as {
    code?: unknown;
    errno?: unknown;
    driverError?: unknown;
    cause?: unknown;
  };
  if (candidate.code === 'ER_DUP_ENTRY' || candidate.errno === 1062) return true;
  return (
    isDuplicateKeyError(candidate.driverError, depth + 1) ||
    isDuplicateKeyError(candidate.cause, depth + 1)
  );
}
