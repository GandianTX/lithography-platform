// src/features/maintenance-report/infrastructure/maintenance-report-adapter.attachments.spec.ts
//
// 附件链路适配层单测：任务 11 上传暂存（REST）→ 挂接/移除（GraphQL）。
// 网络层全部打桩，不发真实请求；失败路径按错误码/服务端 userMessage 明确落文案。

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/graphql', () => ({
  executeGraphQL: vi.fn(),
  readGraphQLErrorDetail: vi.fn(),
}));

vi.mock('@/shared/http', () => ({
  fetchRestWithAuthRetry: vi.fn(),
  readRestErrorField: vi.fn(),
  toRestErrorEnvelope: vi.fn(),
}));

import { executeGraphQL, readGraphQLErrorDetail } from '@/shared/graphql';
import { fetchRestWithAuthRetry, readRestErrorField, toRestErrorEnvelope } from '@/shared/http';

import {
  addMaintenanceReportAttachment,
  createMaintenanceReportDraft,
  removeMaintenanceReportAttachment,
  submitMaintenanceReport,
  updateMaintenanceReportDraft,
  uploadMaintenanceReportOriginal,
} from './maintenance-report-adapter';

const mockFetch = vi.mocked(fetchRestWithAuthRetry);
const mockExecute = vi.mocked(executeGraphQL);
const mockReadDetail = vi.mocked(readGraphQLErrorDetail);
const mockToEnvelope = vi.mocked(toRestErrorEnvelope);
const mockReadField = vi.mocked(readRestErrorField);

const stagedFile = {
  fileId: 'f-1',
  uploadContextId: 'ctx-1',
  originalFilename: 'photo.png',
  mimeType: 'image/png',
  byteSize: 3,
  checksumSha256: 'a'.repeat(64),
};

function okResponse(payload: unknown): Response {
  return new Response(JSON.stringify({ data: payload }), { status: 200 });
}

describe('uploadMaintenanceReportOriginal（任务 11 上传暂存）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('成功：返回正式 uploadContextId 与校验元数据（MAINTENANCE_REPORT 用途）', async () => {
    mockFetch.mockResolvedValue(okResponse(stagedFile));

    const result = await uploadMaintenanceReportOriginal(new File(['abc'], 'photo.png'));

    expect(result).toEqual({ ok: true, file: stagedFile });
    const [, requestInit] = mockFetch.mock.calls[0] ?? [];
    const body = requestInit?.body as FormData;
    expect(body.get('businessType')).toBe('MAINTENANCE_REPORT');
  });

  it('超限（STORED_FILE_UPLOAD_FILE_TOO_LARGE）：按错误码明确拒绝', async () => {
    mockFetch.mockResolvedValue(
      new Response('{"code":"STORED_FILE_UPLOAD_FILE_TOO_LARGE"}', { status: 413 }),
    );
    mockToEnvelope.mockReturnValue({ data: { code: 'STORED_FILE_UPLOAD_FILE_TOO_LARGE' } });
    mockReadField.mockReturnValue('STORED_FILE_UPLOAD_FILE_TOO_LARGE' as never);

    const result = await uploadMaintenanceReportOriginal(new File(['abc'], 'photo.png'));

    expect(result).toMatchObject({ ok: false, reason: 'file-too-large' });
    expect(result.ok === false && result.message.length > 0).toBe(true);
  });

  it('网络失败：upload-failed 明确文案，不伪称成功', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));

    const result = await uploadMaintenanceReportOriginal(new File(['abc'], 'photo.png'));

    expect(result).toMatchObject({ ok: false, reason: 'upload-failed' });
  });
});

describe('addMaintenanceReportAttachment / removeMaintenanceReportAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('挂接成功：只传暂存标识（元数据以服务端事实为准）', async () => {
    mockExecute.mockResolvedValue({});

    const result = await addMaintenanceReportAttachment({ reportId: 1, file: stagedFile });

    expect(result).toEqual({ ok: true });
    expect(mockExecute).toHaveBeenCalledWith(
      expect.stringContaining('addMaintenanceReportAttachment'),
      {
        input: {
          reportId: 1,
          fileId: 'f-1',
          uploadContextId: 'ctx-1',
        },
      },
    );
  });

  it('挂接失败（原件失效/无权）：透传服务端 userMessage', async () => {
    mockExecute.mockRejectedValue(new Error('graphql'));
    mockReadDetail.mockReturnValue({
      code: 'STORED_FILE_FILE_NOT_AVAILABLE',
      errorMessage: '原件尚未完成校验或已失效，请重新上传',
      categoryCode: null,
      userMessage: null,
    } as unknown as ReturnType<typeof readGraphQLErrorDetail>);

    const result = await addMaintenanceReportAttachment({ reportId: 1, file: stagedFile });

    expect(result).toEqual({
      ok: false,
      message: '原件尚未完成校验或已失效，请重新上传',
    });
  });

  it('挂接失败且服务端无 userMessage：给明确兜底文案', async () => {
    mockExecute.mockRejectedValue(new Error('graphql'));
    mockReadDetail.mockReturnValue(null);

    const result = await addMaintenanceReportAttachment({ reportId: 1, file: stagedFile });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.message.length > 0).toBe(true);
  });

  it('移除成功', async () => {
    mockExecute.mockResolvedValue({});

    const result = await removeMaintenanceReportAttachment({ reportId: 1, attachmentId: 7 });

    expect(result).toEqual({ ok: true });
    expect(mockExecute).toHaveBeenCalledWith(
      expect.stringContaining('removeMaintenanceReportAttachment'),
      { input: { reportId: 1, attachmentId: 7 } },
    );
  });

  it('移除失败：明确文案', async () => {
    mockExecute.mockRejectedValue(new Error('graphql'));
    mockReadDetail.mockReturnValue(null);

    const result = await removeMaintenanceReportAttachment({ reportId: 1, attachmentId: 7 });

    expect(result).toMatchObject({ ok: false });
  });

  it('R050-02/R062-01：续填草稿可携带暂存原件（同事务绑定/更换）', async () => {
    mockExecute.mockResolvedValue({
      updateMaintenanceReportDraft: { reportId: 1, status: 'DRAFT', currentVersionNo: 1 },
    });

    await updateMaintenanceReportDraft({
      reportId: 1,
      draft: { title: '续填' },
      attachment: { fileId: 'f-9', uploadContextId: 'ctx-9' },
    });

    expect(mockExecute).toHaveBeenCalledWith(
      expect.stringContaining('updateMaintenanceReportDraft'),
      {
        input: {
          reportId: 1,
          draft: expect.objectContaining({ title: '续填' }),
          attachment: { fileId: 'f-9', uploadContextId: 'ctx-9' },
        },
      },
    );

    await updateMaintenanceReportDraft({ reportId: 1, draft: { title: '续填' } });
    expect(mockExecute.mock.calls[1]?.[1]).toMatchObject({
      input: { reportId: 1, attachment: undefined },
    });
  });
});

describe('契约边界：attachment 入参只发送 {fileId, uploadContextId}', () => {
  /**
   * 背景（2026-11-21 实库验收发现）：正式提交把任务 11 上传返回的完整
   * StoredFile DTO（含 businessType/status/bindingStatus 等服务端只读字段）
   * 原样作为 attachment 发送，被 GraphQL 变量校验拒绝。适配层必须在
   * 发送前裁剪为契约允许的两个标识字段，且不放宽 GraphQL 输入校验。
   */
  const rawStagedFile = {
    fileId: 'f-1',
    uploadContextId: 'ctx-1',
    originalFilename: 'accept-upload-sample.txt',
    mimeType: 'text/plain',
    byteSize: 111,
    checksumSha256: 'a'.repeat(64),
    businessType: 'MAINTENANCE_REPORT',
    status: 'VALID',
    bindingStatus: 'TEMPORARY',
    businessId: null,
    verifiedAt: '2026-11-21T07:30:32.716Z',
    createdAt: '2026-11-21T07:30:32.719Z',
  } as unknown as Parameters<typeof submitMaintenanceReport>[0]['attachment'];

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue({
      submitMaintenanceReport: { reportId: 1, status: 'SUBMITTED', currentVersionNo: 1 },
    } as never);
  });

  it('submitMaintenanceReport：裁剪服务端只读字段', async () => {
    await submitMaintenanceReport({
      sourceType: 'HISTORICAL_CASE' as never,
      repairRequestId: null,
      reportId: null,
      expectedVersionNo: null,
      submissionRequestId: 'sub-1',
      draft: { title: 't' },
      attachment: rawStagedFile,
    });

    const input = (mockExecute.mock.calls[0]?.[1] as { input: { attachment?: unknown } }).input;
    expect(input.attachment).toEqual({ fileId: 'f-1', uploadContextId: 'ctx-1' });
  });

  it('createMaintenanceReportDraft：首存绑定同样裁剪', async () => {
    mockExecute.mockResolvedValue({
      createMaintenanceReportDraft: { reportId: 1, status: 'DRAFT', currentVersionNo: 0 },
    } as never);

    await createMaintenanceReportDraft({
      sourceType: 'HISTORICAL_CASE' as never,
      repairRequestId: null,
      draft: { title: 't' },
      attachment: rawStagedFile,
    });

    const input = (mockExecute.mock.calls[0]?.[1] as { input: { attachment?: unknown } }).input;
    expect(input.attachment).toEqual({ fileId: 'f-1', uploadContextId: 'ctx-1' });
  });

  it('updateMaintenanceReportDraft：续填更换原件同样裁剪', async () => {
    mockExecute.mockResolvedValue({
      updateMaintenanceReportDraft: { reportId: 1, status: 'DRAFT', currentVersionNo: 1 },
    } as never);

    await updateMaintenanceReportDraft({
      reportId: 1,
      draft: { title: 't' },
      attachment: rawStagedFile,
    });

    const input = (mockExecute.mock.calls[0]?.[1] as { input: { attachment?: unknown } }).input;
    expect(input.attachment).toEqual({ fileId: 'f-1', uploadContextId: 'ctx-1' });
  });

  it('未携带附件时不发送 attachment 字段语义（undefined）', async () => {
    await submitMaintenanceReport({
      sourceType: 'HISTORICAL_CASE' as never,
      repairRequestId: null,
      reportId: null,
      expectedVersionNo: null,
      submissionRequestId: 'sub-2',
      draft: { title: 't' },
      attachment: null,
    });

    const input = (mockExecute.mock.calls[0]?.[1] as { input: { attachment?: unknown } }).input;
    expect(input.attachment).toBeUndefined();
  });
});
