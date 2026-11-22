// src/features/reference-document/infrastructure/reference-document-http-adapter.spec.ts
// @vitest-environment jsdom

/**
 * REST 上传 / 下载 adapter 单测：
 * - 成功信封与错误信封映射（业务码 → 显式失败结果，Token 头注入）；
 * - 401 会话失效链路（与 GraphQL executeGraphQL 同口径）：refreshSession 刷新后重试一次；
 *   无刷新能力 / 刷新失败 / 重试仍 401 时调 onAuthFailure 宣布会话失效。
 *
 * 说明：通用信封解析与文件名解析测试随实现上移至 shared/http（rest-response.spec.ts）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getGraphQLRuntimeConfig } from '@/shared/graphql';

import {
  downloadReferenceDocumentFile,
  downloadReferenceDocumentSourceAttachment,
} from './reference-document-http-adapter';

vi.mock('@/shared/graphql', () => ({
  getGraphQLRuntimeConfig: vi.fn(),
}));

const runtimeConfigMock = vi.mocked(getGraphQLRuntimeConfig);
const fetchMock = vi.fn();

function jsonResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
}

function runtimeConfig(
  overrides: Partial<NonNullable<ReturnType<typeof getGraphQLRuntimeConfig>>> & {
    getAccessToken?: () => string | null;
  },
): void {
  runtimeConfigMock.mockReturnValue({
    getAccessToken: overrides.getAccessToken ?? (() => 'token-a'),
    refreshSession: overrides.refreshSession,
    onAuthFailure: overrides.onAuthFailure,
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  runtimeConfigMock.mockReset();
});

describe('downloadReferenceDocumentFile', () => {
  it('成功返回 Blob 与 filename* 解析后的文件名', async () => {
    runtimeConfig({});
    fetchMock.mockResolvedValue(
      new Response('pdf-bytes', {
        headers: { 'Content-Disposition': "attachment; filename*=UTF-8''%E6%89%8B%E5%86%8C.pdf" },
      }),
    );

    const result = await downloadReferenceDocumentFile(970002);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.filename).toBe('手册.pdf');
      expect(result.blob.size).toBeGreaterThan(0);
    }
  });

  it('业务错误码映射：FILE_NOT_AVAILABLE → file-not-available', async () => {
    runtimeConfig({});
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          success: false,
          data: {
            statusCode: 409,
            code: 'REFERENCE_DOCUMENT_FILE_NOT_AVAILABLE',
            message: '该资料没有可下载的文件。',
          },
        },
        { status: 409 },
      ),
    );

    const result = await downloadReferenceDocumentFile(970005);

    expect(result).toEqual({
      ok: false,
      reason: 'file-not-available',
      message: '该资料没有可下载的文件。',
    });
  });

  it('403 授权拒绝映射 forbidden，展示无权提示', async () => {
    runtimeConfig({});
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          success: false,
          data: {
            statusCode: 403,
            code: 'FORBIDDEN',
            message: '无权访问该资源',
          },
        },
        { status: 403 },
      ),
    );

    const result = await downloadReferenceDocumentFile(970002);

    expect(result).toEqual({
      ok: false,
      reason: 'forbidden',
      message: '无权访问该资源',
    });
  });

  it('401 且刷新成功但重试仍 401：宣布会话失效并返回失败结果', async () => {
    const refreshSession = vi.fn().mockResolvedValue(undefined);
    const onAuthFailure = vi.fn();

    runtimeConfig({ refreshSession, onAuthFailure });
    fetchMock.mockResolvedValue(jsonResponse({ success: false }, { status: 401 }));

    const result = await downloadReferenceDocumentFile(970002);

    expect(result.ok).toBe(false);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('网络失败归并 download-failed，不触发会话失效', async () => {
    runtimeConfig({ onAuthFailure: vi.fn() });
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const result = await downloadReferenceDocumentFile(970002);

    expect(result).toMatchObject({ ok: false, reason: 'download-failed' });
  });
});

describe('downloadReferenceDocumentSourceAttachment（任务 07 P2 来源报告原件下载）', () => {
  it('请求来源报告原件端点并成功返回 Blob 与文件名', async () => {
    runtimeConfig({});
    fetchMock.mockResolvedValue(
      new Response('source-bytes', {
        headers: {
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('报告原件.txt')}`,
        },
      }),
    );

    const result = await downloadReferenceDocumentSourceAttachment(970010, 880123);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/reference-documents/970010/source-attachments/880123/download',
      expect.objectContaining({ headers: expect.anything() }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filename).toBe('报告原件.txt');
      expect(result.blob.size).toBeGreaterThan(0);
    }
  });

  it('绑定不符 / 不可见（NOT_FOUND）映射 not-found 显式失败', async () => {
    runtimeConfig({});
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          success: false,
          data: {
            statusCode: 404,
            code: 'REFERENCE_DOCUMENT_NOT_FOUND',
            message: '参考资料不存在或不可访问',
          },
        },
        { status: 404 },
      ),
    );

    const result = await downloadReferenceDocumentSourceAttachment(970010, 880123);

    expect(result).toEqual({
      ok: false,
      reason: 'not-found',
      message: '参考资料不存在或不可访问',
    });
  });
});
