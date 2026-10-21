// src/features/content-submission/infrastructure/content-submission-attachment-adapter.spec.ts
// @vitest-environment jsdom

/**
 * 内容投稿附件 REST adapter 单测：
 * - 成功信封归一（attachmentId → id；下载文件名解析与兜底）；
 * - 业务码 → 显式失败结果映射（含守卫三权限码、组织成员事实码与未映射码兜底，不泄露细码）；
 * - 鉴权失效链路：401 无刷新能力时宣布会话失效，落 upload-failed 兜底；
 * - transport / 非 JSON 错误体 / 成功但形状不符的防御。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getGraphQLRuntimeConfig } from '@/shared/graphql';

import {
  downloadContentSubmissionAttachment,
  removeContentSubmissionAttachment,
  uploadContentSubmissionAttachment,
} from './content-submission-attachment-adapter';

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

function errorEnvelope(code: string, message: string, status = 400): Response {
  return jsonResponse({ success: false, data: { statusCode: status, code, message } }, { status });
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

function fileInput(name = 'case.pdf'): File {
  return new File(['file-bytes'], name, { type: 'application/pdf' });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  runtimeConfigMock.mockReset();
});

describe('uploadContentSubmissionAttachment', () => {
  it('成功信封归一为 attachment；POST multipart 到附件端点并注入 Token', async () => {
    runtimeConfig({});
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          attachmentId: 55,
          originalFilename: 'case.pdf',
          mimeType: 'application/pdf',
          byteSize: 1024,
        },
      }),
    );

    const result = await uploadContentSubmissionAttachment(12, fileInput());

    expect(result).toEqual({
      ok: true,
      attachment: {
        id: 55,
        originalFilename: 'case.pdf',
        mimeType: 'application/pdf',
        byteSize: 1024,
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('/api/content-submissions/12/attachment');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-a');
  });

  it.each([
    ['CONTENT_SUBMISSION_NOT_FOUND', 'not-found', 404],
    ['CONTENT_SUBMISSION_INVALID_PARAMS', 'invalid-input', 400],
    ['CONTENT_SUBMISSION_UPLOAD_FILE_MISSING', 'invalid-input', 400],
    ['CONTENT_SUBMISSION_UPLOAD_FILE_TOO_LARGE', 'file-too-large', 400],
    ['CONTENT_SUBMISSION_UPLOAD_FILE_TYPE_NOT_ALLOWED', 'file-type-not-allowed', 415],
    ['CONTENT_SUBMISSION_STATE_NOT_EDITABLE', 'state-conflict', 409],
    ['INSUFFICIENT_PERMISSIONS', 'forbidden', 403],
    ['ACCESS_DENIED', 'forbidden', 403],
    ['ROLE_REQUIRED', 'forbidden', 403],
    ['ORGANIZATION_NO_ACTIVE_MEMBERSHIP', 'forbidden', 403],
    ['ORGANIZATION_AMBIGUOUS_MEMBERSHIP', 'forbidden', 403],
  ] as const)('业务码 %s → %s（后端 message 透传）', async (code, reason, status) => {
    runtimeConfig({});
    fetchMock.mockResolvedValue(errorEnvelope(code, '后端业务消息', status));

    const result = await uploadContentSubmissionAttachment(12, fileInput());

    expect(result).toEqual({ ok: false, reason, message: '后端业务消息' });
  });

  it('未映射码（JWT 失效）落 upload-failed 兜底；401 无刷新能力时宣布会话失效', async () => {
    const onAuthFailure = vi.fn();

    runtimeConfig({ onAuthFailure });
    fetchMock.mockResolvedValue(errorEnvelope('JWT_AUTHENTICATION_FAILED', '会话已失效。', 401));

    const result = await uploadContentSubmissionAttachment(12, fileInput());

    expect(result).toEqual({ ok: false, reason: 'upload-failed', message: '会话已失效。' });
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    // 无刷新能力不重试：只发一次请求
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('未映射码无 message 时落兜底文案；非 JSON 错误体不炸', async () => {
    runtimeConfig({});
    fetchMock.mockResolvedValue(errorEnvelope('SOMETHING_ELSE', '', 500));

    await expect(uploadContentSubmissionAttachment(12, fileInput())).resolves.toEqual({
      ok: false,
      reason: 'upload-failed',
      message: '附件上传失败，请稍后重试。',
    });

    fetchMock.mockResolvedValue(new Response('<html>网关错误</html>', { status: 502 }));

    await expect(uploadContentSubmissionAttachment(12, fileInput())).resolves.toEqual({
      ok: false,
      reason: 'upload-failed',
      message: '附件上传失败，请稍后重试。',
    });
  });

  it('成功状态但 data 形状不符（缺 attachmentId）落 upload-failed', async () => {
    runtimeConfig({});
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { originalFilename: 'a.pdf' } }),
    );

    await expect(uploadContentSubmissionAttachment(12, fileInput())).resolves.toEqual({
      ok: false,
      reason: 'upload-failed',
      message: '附件上传失败，请稍后重试。',
    });
  });

  it('网络失败归并 upload-failed 并提示检查网络', async () => {
    runtimeConfig({});
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(uploadContentSubmissionAttachment(12, fileInput())).resolves.toEqual({
      ok: false,
      reason: 'upload-failed',
      message: '附件上传失败，请检查网络后重试。',
    });
  });
});

describe('removeContentSubmissionAttachment', () => {
  it('删除成功返回 ok；DELETE 到附件端点', async () => {
    runtimeConfig({});
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(removeContentSubmissionAttachment(12)).resolves.toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('/api/content-submissions/12/attachment');
    expect(init.method).toBe('DELETE');
  });

  it.each([
    ['CONTENT_SUBMISSION_NOT_FOUND', 'not-found', 404],
    ['CONTENT_SUBMISSION_STATE_NOT_EDITABLE', 'state-conflict', 409],
    ['INSUFFICIENT_PERMISSIONS', 'forbidden', 403],
    ['ORGANIZATION_NO_ACTIVE_MEMBERSHIP', 'forbidden', 403],
  ] as const)('业务码 %s → %s', async (code, reason, status) => {
    runtimeConfig({});
    fetchMock.mockResolvedValue(errorEnvelope(code, '后端业务消息', status));

    await expect(removeContentSubmissionAttachment(12)).resolves.toEqual({
      ok: false,
      reason,
      message: '后端业务消息',
    });
  });

  it('未映射码与网络失败落 remove-failed 兜底', async () => {
    runtimeConfig({});
    fetchMock.mockResolvedValue(errorEnvelope('UNKNOWN_CODE', '', 500));

    await expect(removeContentSubmissionAttachment(12)).resolves.toEqual({
      ok: false,
      reason: 'remove-failed',
      message: '附件移除失败，请稍后重试。',
    });

    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(removeContentSubmissionAttachment(12)).resolves.toEqual({
      ok: false,
      reason: 'remove-failed',
      message: '附件移除失败，请检查网络后重试。',
    });
  });
});

describe('downloadContentSubmissionAttachment', () => {
  it('成功返回 Blob 与 filename* 解析后的文件名', async () => {
    runtimeConfig({});
    fetchMock.mockResolvedValue(
      new Response('pdf-bytes', {
        headers: { 'Content-Disposition': "attachment; filename*=UTF-8''%E6%8A%95%E7%A8%BF.pdf" },
      }),
    );

    const result = await downloadContentSubmissionAttachment(12, 55);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.filename).toBe('投稿.pdf');
      expect(result.blob.size).toBeGreaterThan(0);
    }

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('/api/content-submissions/12/attachments/55/download');
  });

  it('缺失 Content-Disposition 时使用兜底文件名', async () => {
    runtimeConfig({});
    fetchMock.mockResolvedValue(new Response('bytes'));

    const result = await downloadContentSubmissionAttachment(12, 55);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.filename).toBe('content-submission-attachment-55');
    }
  });

  it.each([
    ['CONTENT_SUBMISSION_NOT_FOUND', 'not-found', 404],
    ['CONTENT_SUBMISSION_FILE_NOT_AVAILABLE', 'file-not-available', 409],
    ['ACCESS_DENIED', 'forbidden', 403],
    ['ORGANIZATION_AMBIGUOUS_MEMBERSHIP', 'forbidden', 403],
  ] as const)('业务码 %s → %s', async (code, reason, status) => {
    runtimeConfig({});
    fetchMock.mockResolvedValue(errorEnvelope(code, '后端业务消息', status));

    await expect(downloadContentSubmissionAttachment(12, 55)).resolves.toEqual({
      ok: false,
      reason,
      message: '后端业务消息',
    });
  });

  it('未映射码与网络失败落 download-failed 兜底', async () => {
    runtimeConfig({});
    fetchMock.mockResolvedValue(errorEnvelope('UNKNOWN_CODE', '', 500));

    await expect(downloadContentSubmissionAttachment(12, 55)).resolves.toEqual({
      ok: false,
      reason: 'download-failed',
      message: '下载失败，请稍后重试。',
    });

    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(downloadContentSubmissionAttachment(12, 55)).resolves.toEqual({
      ok: false,
      reason: 'download-failed',
      message: '下载失败，请检查网络后重试。',
    });
  });
});
