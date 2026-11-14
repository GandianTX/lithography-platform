// 文件位置：src/modules/common/utils/sql-like-pattern.util.ts

/**
 * 转义 SQL `LIKE` 模式中的通配符（通用工具）。
 *
 * `\`、`%`、`_` 在 `LIKE` 中具有特殊含义，用户输入的关键字必须先转义再拼成
 * `%keyword%`，否则会被当成通配符，导致模糊搜索范围被放大。调用方仍需用
 * `ESCAPE '\\'` 或等价的 QueryBuilder 参数化方式配套使用。
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
