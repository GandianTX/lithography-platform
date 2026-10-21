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
  createReferenceDocumentWithFile,
  downloadReferenceDocumentFile,
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

function fileInput(): File {
  return new File(['file-bytes'], 'manual.pdf', { type: 'application/pdf' });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  runtimeConfigMock.mockReset();
});

describe('createReferenceDocumentWithFile', () => {
  it('成功信封返回 id；Authorization 头注入当前 Token', async () => {
    runtimeConfig({});
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { id: 808 } }));

    const result = await createReferenceDocumentWithFile({
      title: '新资料',
      documentType: 'CHECKLIST',
      equipmentModelId: null,
      description: null,
      contentText: null,
      file: fileInput(),
    });

    expect(result).toEqual({ ok: true, id: 808 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('/api/reference-documents/upload');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-a');
  });

  it('业务错误码映射为显式失败结果（后端码 → reason，message 透传）', async () => {
    runtimeConfig({});
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          success: false,
          data: {
            statusCode: 400,
            code: 'REFERENCE_DOCUMENT_UPLOAD_FILE_TOO_LARGE',
            message: '文件超出大小上限。',
          },
        },
        { status: 400 },
      ),
    );

    const result = await createReferenceDocumentWithFile({
      title: '新资料',
      documentType: 'CHECKLIST',
      equipmentModelId: null,
      description: null,
      contentText: null,
      file: fileInput(),
    });

    expect(result).toEqual({ ok: false, reason: 'file-too-large', message: '文件超出大小上限。' });
  });

  it('401 且无 refreshSession：宣布会话失效并返回失败结果', async () => {
    const onAuthFailure = vi.fn();

    runtimeConfig({ onAuthFailure });
    fetchMock.mockResolvedValue(jsonResponse({ success: false }, { status: 401 }));

    const result = await createReferenceDocumentWithFile({
      title: '新资料',
      documentType: 'CHECKLIST',
      equipmentModelId: null,
      description: null,
      contentText: null,
      file: fileInput(),
    });

    expect(result.ok).toBe(false);
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    // 不重试：只发一次请求
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('401 且刷新成功：用新 Token 重试一次并成功，不宣布会话失效', async () => {
    const refreshSession = vi.fn().mockResolvedValue(undefined);
    const onAuthFailure = vi.fn();
    const getAccessToken = vi
      .fn<() => string>()
      .mockReturnValueOnce('expired-token')
      .mockReturnValueOnce('fresh-token');

    runtimeConfig({ getAccessToken, refreshSession, onAuthFailure });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: false }, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { id: 809 } }));

    const result = await createReferenceDocumentWithFile({
      title: '新资料',
      documentType: 'CHECKLIST',
      equipmentModelId: null,
      description: null,
      contentText: null,
      file: fileInput(),
    });

    expect(result).toEqual({ ok: true, id: 809 });
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(onAuthFailure).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 重试请求携带刷新后的 Token
    const [, retryInit] = fetchMock.mock.calls[1] as [string, RequestInit];

    expect((retryInit.headers as Record<string, string>).Authorization).toBe('Bearer fresh-token');
  });

  it('401 且刷新失败：宣布会话失效并返回失败结果', async () => {
    const refreshSession = vi.fn().mockRejectedValue(new Error('refresh failed'));
    const onAuthFailure = vi.fn();

    runtimeConfig({ refreshSession, onAuthFailure });
    fetchMock.mockResolvedValue(jsonResponse({ success: false }, { status: 401 }));

    const result = await createReferenceDocumentWithFile({
      title: '新资料',
      documentType: 'CHECKLIST',
      equipmentModelId: null,
      description: null,
      contentText: null,
      file: fileInput(),
    });

    expect(result.ok).toBe(false);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
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
