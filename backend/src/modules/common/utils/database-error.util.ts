// 文件位置：src/modules/common/utils/database-error.util.ts
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

/**
 * 读取唯一键冲突命中的索引名（如 `uk_provisioning_purpose_actor_key`）。
 *
 * MySQL 驱动文本形如 `Duplicate entry '...' for key 'table.index'`；
 * 驱动版本差异可能存在裸索引名与 `table.index` 两种形态，调用方需同时兼容。
 * 不命中（非重复键、文本不含索引名或已超过包装层数）时返回 `null`。
 */
export function findDuplicateKeyName(error: unknown, depth = 0): string | null {
  if (typeof error !== 'object' || error === null || depth > 3) return null;
  const candidate = error as {
    message?: unknown;
    driverError?: unknown;
    cause?: unknown;
  };

  if (typeof candidate.message === 'string') {
    const matched = /for key '([^']+)'/.exec(candidate.message);
    if (matched !== null) return matched[1];
  }

  return (
    findDuplicateKeyName(candidate.driverError, depth + 1) ??
    findDuplicateKeyName(candidate.cause, depth + 1)
  );
}
