// src/shared/http/rest-response.spec.ts

/**
 * REST 响应信封工具单测：
 * - 信封解析（data.code / data.message 提取，非对象、缺 data、空串安全归一）；
 * - Content-Disposition 文件名解析（filename* 优先于 filename）。
 */

import { describe, expect, it } from 'vitest';

import { parseAttachmentFilename, readRestErrorField, toRestErrorEnvelope } from './rest-response';

describe('toRestErrorEnvelope / readRestErrorField', () => {
  it('从信封中提取 code 与 message（含 statusCode 场景不干扰）', () => {
    const envelope = toRestErrorEnvelope({
      success: false,
      data: { statusCode: 400, code: 'X_INVALID_PARAMS', message: '参数错误。' },
    });

    expect(readRestErrorField(envelope, 'code')).toBe('X_INVALID_PARAMS');
    expect(readRestErrorField(envelope, 'message')).toBe('参数错误。');
  });

  it('非对象 / 缺失 data 时安全归一为空信封', () => {
    expect(toRestErrorEnvelope(null)).toEqual({});
    expect(toRestErrorEnvelope('oops')).toEqual({});
    expect(toRestErrorEnvelope({ success: false })).toEqual({});
    expect(readRestErrorField({}, 'code')).toBeNull();
    expect(readRestErrorField({}, 'message')).toBeNull();
  });

  it('空字符串字段按缺失处理', () => {
    const envelope = toRestErrorEnvelope({ data: { code: '', message: '' } });

    expect(readRestErrorField(envelope, 'code')).toBeNull();
    expect(readRestErrorField(envelope, 'message')).toBeNull();
  });
});

describe('parseAttachmentFilename', () => {
  it('filename* 优先；非法编码原样返回；无头返回 null', () => {
    expect(parseAttachmentFilename("attachment; filename*=UTF-8''%E6%89%8B%E5%86%8C.pdf")).toBe(
      '手册.pdf',
    );
    expect(parseAttachmentFilename('attachment; filename="fallback.pdf"')).toBe('fallback.pdf');
    expect(parseAttachmentFilename('attachment; filename="a.pdf"; filename*=UTF-8\'\'bad%ZZ')).toBe(
      'bad%ZZ',
    );
    expect(parseAttachmentFilename(null)).toBeNull();
  });
});
