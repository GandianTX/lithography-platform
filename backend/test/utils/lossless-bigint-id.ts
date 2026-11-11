// test/utils/lossless-bigint-id.ts

/**
 * BIGINT ID 无损归一化（仅供测试规格使用）。
 *
 * TypeORM MySQL 驱动默认 `supportBigNumbers=true`、`bigNumberStrings=true`，
 * 原始 query 会把 BIGINT 列返回为 JS string。JS number 的安全整数上限为
 * 2^53 - 1，超过后 `Number(value)` 会静默丢精度，因此这里不把 ID 统一转成
 * number，而是统一归一化为十进制字符串：
 *
 * - string：必须匹配十进制整数，规范化后返回（去掉前导零/正号，`-0` → `0`）；
 * - number：只接受安全整数，超出安全范围直接拒绝并要求改用字符串；
 * - bigint：原样转为十进制字符串。
 *
 * 查询结果 Map 的键与查找键必须都经过本函数归一化，禁止用 number 直接查找。
 */

export type LosslessId = string | number | bigint;

const DECIMAL_INTEGER = /^-?\d+$/;

export const normalizeBigIntId = (value: LosslessId, field = 'id'): string => {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`${field} 不是整数：${String(value)}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${field} 超出安全整数范围，必须以字符串传入：${String(value)}`);
    }
    return String(value);
  }

  const text = value.trim();
  if (!DECIMAL_INTEGER.test(text)) {
    throw new Error(`${field} 不是十进制整数字符串：${JSON.stringify(value)}`);
  }
  return BigInt(text).toString();
};
