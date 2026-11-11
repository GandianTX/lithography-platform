// src/infrastructure/database/lossless-bigint-id.spec.ts

import { normalizeBigIntId } from '../../../test/utils/lossless-bigint-id';

describe('normalizeBigIntId（BIGINT ID 无损归一化）', () => {
  it('string 与同值 number 归一化为同一字符串', () => {
    expect(normalizeBigIntId('42')).toBe('42');
    expect(normalizeBigIntId(42)).toBe('42');
    expect(normalizeBigIntId('042')).toBe('42');
    expect(normalizeBigIntId(' 42 ')).toBe('42');
    expect(normalizeBigIntId(0)).toBe('0');
    expect(normalizeBigIntId('-7')).toBe('-7');
    expect(normalizeBigIntId('-0')).toBe('0');
  });

  it('超安全整数范围的 BIGINT 以字符串/BigInt 无损保留', () => {
    // 2^53 + 1，Number 无法精确表示
    expect(normalizeBigIntId('9007199254740993')).toBe('9007199254740993');
    expect(normalizeBigIntId(BigInt('9007199254740993'))).toBe('9007199254740993');
    // BIGINT UNSIGNED 上限
    expect(normalizeBigIntId('18446744073709551615')).toBe('18446744073709551615');
    expect(normalizeBigIntId(BigInt('18446744073709551615'))).toBe('18446744073709551615');
  });

  it('number 超出安全整数范围时拒绝而不是丢精度', () => {
    expect(() => normalizeBigIntId(Number.MAX_SAFE_INTEGER + 1)).toThrow(/安全整数范围/);
    expect(() => normalizeBigIntId(Number.MAX_SAFE_INTEGER + 2)).toThrow(/安全整数范围/);
    expect(() => normalizeBigIntId(Number.parseFloat('9007199254740993'))).toThrow(/安全整数范围/);
  });

  it('非整数或非十进制整数字符串拒绝', () => {
    expect(() => normalizeBigIntId(1.5)).toThrow(/不是整数/);
    expect(() => normalizeBigIntId(Number.NaN)).toThrow(/不是整数/);
    expect(() => normalizeBigIntId('1e3')).toThrow(/不是十进制整数字符串/);
    expect(() => normalizeBigIntId('0x10')).toThrow(/不是十进制整数字符串/);
    expect(() => normalizeBigIntId('')).toThrow(/不是十进制整数字符串/);
    expect(() => normalizeBigIntId('   ')).toThrow(/不是十进制整数字符串/);
    expect(() => normalizeBigIntId('12.0')).toThrow(/不是十进制整数字符串/);
  });

  it('错误信息包含字段名便于定位', () => {
    expect(() => normalizeBigIntId('abc', 'record_package_item.id')).toThrow(
      /record_package_item\.id 不是十进制整数字符串/,
    );
  });
});
