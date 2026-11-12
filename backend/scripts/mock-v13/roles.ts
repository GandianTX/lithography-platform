// scripts/mock-v13/roles.ts

/**
 * access_group / meta_digest 的统一严格解析器。
 *
 * MySQL JSON 列经 mysql2 读取后是原生数组；历史数据与加密字段则是 JSON 字符串。
 * 两种形态都必须接受，但只接受“字符串元素组成的数组”，其余一律返回 null，
 * 由调用方按各自的错误语义（校验失败或冲突）处理。
 */
export function parseRoleArrayValue(value: unknown): string[] | null {
  let parsed: unknown;
  if (Array.isArray(value)) {
    parsed = value;
  } else if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  } else {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    return null;
  }
  return parsed as string[];
}
