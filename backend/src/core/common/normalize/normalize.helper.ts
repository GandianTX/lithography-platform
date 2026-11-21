// src/core/common/normalize/normalize.helper.ts
// src/core/common/normalize.helper.ts

/**
 * 邮箱标准化处理
 * 统一的邮箱标准化逻辑：去除首尾空格 + 转小写
 * @param email 原始邮箱地址
 * @returns 标准化后的邮箱地址
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * 手机号标准化处理
 * 统一的手机号标准化逻辑：仅保留数字字符
 * @param phone 原始手机号
 * @returns 标准化后的手机号（仅包含数字）
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * 通用标准化处理器
 * 根据类型自动选择合适的标准化方法
 * @param value 待标准化的值
 * @param type 标准化类型
 * @returns 标准化后的值
 */
export function normalize(value: string, type: 'email' | 'phone'): string {
  switch (type) {
    case 'email':
      return normalizeEmail(value);
    case 'phone':
      return normalizePhone(value);
    default: {
      // TypeScript 会确保这里不会被执行到
      const exhaustiveCheck: never = type;
      throw new Error(`不支持的标准化类型: ${String(exhaustiveCheck)}`);
    }
  }
}

/**
 * 可选文本归一：非字符串或纯空白 → null，其余去首尾空白。
 *
 * 供用例层统一复用，避免在 usecases 内直接调用 `trim()`（见 normalize 守卫）。
 */
export function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 布尔解析：支持 'false' | '0' | 'off' | 'no' | 'disabled' → false；
 * 支持 'true' | '1' | 'on' | 'yes' | 'enabled' → true
 * @param value 待解析值（可能为 string / number / boolean / undefined）
 * @returns 解析后的 boolean，无法识别返回 undefined
 */
export function parseBooleanInput(value: unknown): boolean | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === 'false' ||
      normalized === '0' ||
      normalized === 'off' ||
      normalized === 'no' ||
      normalized === 'disabled'
    ) {
      return false;
    }
    if (
      normalized === 'true' ||
      normalized === '1' ||
      normalized === 'on' ||
      normalized === 'yes' ||
      normalized === 'enabled'
    ) {
      return true;
    }
    return undefined;
  }
  return undefined;
}
