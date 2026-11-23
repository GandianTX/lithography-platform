// src/features/repair-request/application/use-repair-request-create-flow.spec.ts

/**
 * 客户创建报修流程单测（application 状态机，PR #27 复审回归）。
 *
 * 走真实 hook，只 mock 外部 GraphQL adapter；全部竞态用例使用可控延迟（deferred）：
 * - 上传请求标识失效：上传中取消/清空/开始新上传/卸载后，旧成败结果一律不回填；
 * - 提交附件快照：实际提交载荷 = 提交开始时刻页面展示的有效附件；
 * - 「原申请已删除」：同标识重试被服务端失败关闭后的提示、标识保留与
 *   用户明确重新发起（restartSubmission）才换新标识；
 * - 可信公司名称三态：不同账号分别得到各自的可信名称、加载失败、未绑定。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import type {
  RepairRequestRecord,
  UploadRepairRequestFileResult,
} from '../infrastructure/repair-request.types';
import * as repairRequestAdapter from '../infrastructure/repair-request-adapter';

import { useRepairRequestCreateFlow } from './use-repair-request-create-flow';

vi.mock('../infrastructure/repair-request-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof repairRequestAdapter>();

  return {
    ...actual,
    createRepairRequest: vi.fn(),
    fetchEquipmentModels: vi.fn(),
    fetchRepairServiceOrganizations: vi.fn(),
    fetchTrustedCompanyName: vi.fn(),
    uploadRepairRequestFile: vi.fn(),
  };
});

const fetchModelsMock = vi.mocked(repairRequestAdapter.fetchEquipmentModels);
const fetchServiceOrgsMock = vi.mocked(repairRequestAdapter.fetchRepairServiceOrganizations);
const fetchTrustedCompanyNameMock = vi.mocked(repairRequestAdapter.fetchTrustedCompanyName);
const uploadRepairRequestFileMock = vi.mocked(repairRequestAdapter.uploadRepairRequestFile);
const createRepairRequestMock = vi.mocked(repairRequestAdapter.createRepairRequest);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CREATED_RECORD: RepairRequestRecord = {
  id: 1,
  requestNo: 'RR20261121000000ABC123',
  equipmentModelId: 11,
  errorCode: 'E-2001',
  faultDescription: '双工件台干涉仪报错',
  createdAt: '2026-11-21T00:00:00.000Z',
  isAccepted: false,
};

const VALUES = {
  serviceOrganizationId: 88,
  equipmentModelId: 11,
  equipmentModelText: null,
  errorCode: 'E-2001',
  faultDescription: '双工件台干涉仪报错',
} as const;

const STAGED_FILE_A = {
  fileId: 'a1f4f9e9-9a1e-4b6e-8a10-3f1a2b3c4d5e',
  uploadContextId: 'b1f4f9e9-9a1e-4b6e-8a10-3f1a2b3c4d5e',
  originalFilename: '原件A.pdf',
  mimeType: 'application/pdf',
  byteSize: 1024,
  checksumSha256: 'a'.repeat(64),
};
const STAGED_FILE_B = {
  fileId: 'c1f4f9e9-9a1e-4b6e-8a10-3f1a2b3c4d5e',
  uploadContextId: 'd1f4f9e9-9a1e-4b6e-8a10-3f1a2b3c4d5e',
  originalFilename: '原件B.pdf',
  mimeType: 'application/pdf',
  byteSize: 2048,
  checksumSha256: 'b'.repeat(64),
};

/** 可外部结算的 pending promise：精确控制「请求仍在途」时的时序 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

function uploaded(file: typeof STAGED_FILE_A): UploadRepairRequestFileResult {
  return { ok: true, file };
}

function renderFlow() {
  return renderHook(() => useRepairRequestCreateFlow());
}

beforeEach(() => {
  fetchModelsMock.mockResolvedValue([]);
  fetchServiceOrgsMock.mockResolvedValue([]);
  fetchTrustedCompanyNameMock.mockResolvedValue('甲公司');
  createRepairRequestMock.mockReset();
  uploadRepairRequestFileMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('原件上传的请求标识失效（PR #27 复审）', () => {
  it('上传中清空附件：旧成功晚到不回填，附件保持 idle', async () => {
    const pending = deferred<UploadRepairRequestFileResult>();
    uploadRepairRequestFileMock.mockReturnValue(pending.promise);

    const { result } = renderFlow();

    await act(async () => {
      void result.current.uploadAttachment(new File(['pdf'], '原件A.pdf'));
    });
    expect(result.current.attachment.status).toBe('uploading');

    act(() => {
      result.current.clearAttachment();
    });
    expect(result.current.attachment.status).toBe('idle');

    // 旧上传成功晚到：不回填
    await act(async () => {
      pending.resolve(uploaded(STAGED_FILE_A));
    });
    expect(result.current.attachment.status).toBe('idle');
  });

  it('上传中清空附件：旧失败晚到同样不回填（旧错误不覆盖新状态）', async () => {
    const pending = deferred<UploadRepairRequestFileResult>();
    uploadRepairRequestFileMock.mockReturnValue(pending.promise);

    const { result } = renderFlow();

    await act(async () => {
      void result.current.uploadAttachment(new File(['pdf'], '原件A.pdf'));
    });

    act(() => {
      result.current.clearAttachment();
    });

    await act(async () => {
      pending.resolve({ ok: false, reason: 'file-too-large', message: '原件超过 20MB 限制。' });
    });
    expect(result.current.attachment.status).toBe('idle');
  });

  it('取消旧上传后选新文件：旧结果无论何时返回都不覆盖新文件状态', async () => {
    const pendingA = deferred<UploadRepairRequestFileResult>();
    const pendingB = deferred<UploadRepairRequestFileResult>();
    uploadRepairRequestFileMock
      .mockReturnValueOnce(pendingA.promise)
      .mockReturnValueOnce(pendingB.promise);

    const { result } = renderFlow();

    await act(async () => {
      void result.current.uploadAttachment(new File(['pdf'], '原件A.pdf'));
    });
    expect(result.current.attachment).toMatchObject({ status: 'uploading', filename: '原件A.pdf' });

    // 不等 A 完成，直接开始新上传（清空旧上传语义由新上传令牌自增承载）
    await act(async () => {
      void result.current.uploadAttachment(new File(['pdf'], '原件B.pdf'));
    });
    expect(result.current.attachment).toMatchObject({ status: 'uploading', filename: '原件B.pdf' });

    // 旧上传 A 成功晚到：不覆盖 B 的进行中状态
    await act(async () => {
      pendingA.resolve(uploaded(STAGED_FILE_A));
    });
    expect(result.current.attachment).toMatchObject({ status: 'uploading', filename: '原件B.pdf' });

    // 新上传 B 成功：正常回填
    await act(async () => {
      pendingB.resolve(uploaded(STAGED_FILE_B));
    });
    expect(result.current.attachment).toMatchObject({ status: 'ready', file: STAGED_FILE_B });
  });

  it('卸载后旧上传成功晚到：不回填任何状态', async () => {
    const pending = deferred<UploadRepairRequestFileResult>();
    uploadRepairRequestFileMock.mockReturnValue(pending.promise);

    const { result, unmount } = renderFlow();

    await act(async () => {
      void result.current.uploadAttachment(new File(['pdf'], '原件A.pdf'));
    });
    const stateAtUnmount = result.current.attachment;
    unmount();

    await act(async () => {
      pending.resolve(uploaded(STAGED_FILE_A));
    });
    expect(result.current.attachment).toEqual(stateAtUnmount);
  });

  it('提交使用提交开始时刻的附件快照：提交期间清空不影响本次载荷', async () => {
    const pendingSubmit = deferred<{ ok: true; repairRequest: RepairRequestRecord }>();
    uploadRepairRequestFileMock.mockResolvedValue(uploaded(STAGED_FILE_A));
    createRepairRequestMock.mockReturnValue(pendingSubmit.promise);

    const { result } = renderFlow();

    await act(async () => {
      await result.current.uploadAttachment(new File(['pdf'], '原件A.pdf'));
    });
    expect(result.current.attachment.status).toBe('ready');

    await act(async () => {
      void result.current.submit({ ...VALUES });
    });

    // 提交在途时清空附件（UI 展示已变为无附件）
    act(() => {
      result.current.clearAttachment();
    });
    expect(result.current.attachment.status).toBe('idle');

    await act(async () => {
      pendingSubmit.resolve({ ok: true, repairRequest: CREATED_RECORD });
    });

    // 实际载荷 = 提交开始时刻页面展示的有效附件
    expect(createRepairRequestMock.mock.calls[0][0].attachment).toEqual({
      fileId: STAGED_FILE_A.fileId,
      uploadContextId: STAGED_FILE_A.uploadContextId,
    });
    // 清空不被晚到的成功结果复活
    expect(result.current.attachment.status).toBe('idle');
  });
});

describe('「原申请已删除」的同标识重试（PR #27 复审）', () => {
  it('失败后保留同一提交标识，且提示明确引导重新发起', async () => {
    createRepairRequestMock
      .mockResolvedValueOnce({
        ok: false,
        message: '原申请已删除，请重新发起维修申请',
        reason: 'submission-deleted',
      })
      .mockResolvedValueOnce({ ok: true, repairRequest: CREATED_RECORD });

    const { result } = renderFlow();
    await waitFor(() => expect(result.current.modelsState.status).toBe('ready'));

    await act(async () => {
      await result.current.submit({ ...VALUES });
    });
    expect(result.current.submitError).toBe('原申请已删除，请重新发起维修申请');
    expect(result.current.submitFailureReason).toBe('submission-deleted');

    // 未明确重新发起前，重试仍复用同一标识（由服务端失败关闭，不自动重建工单）
    await act(async () => {
      await result.current.submit({ ...VALUES });
    });

    const first = createRepairRequestMock.mock.calls[0][0].recordUuid;
    const second = createRepairRequestMock.mock.calls[1][0].recordUuid;
    expect(first).toMatch(UUID_PATTERN);
    expect(second).toBe(first);
  });

  it('restartSubmission 换新提交标识并清除错误：用户明确重新发起后才创建新工单', async () => {
    createRepairRequestMock.mockResolvedValue({
      ok: false,
      message: '原申请已删除，请重新发起维修申请',
      reason: 'submission-deleted',
    });

    const { result } = renderFlow();
    await waitFor(() => expect(result.current.modelsState.status).toBe('ready'));

    await act(async () => {
      await result.current.submit({ ...VALUES });
    });
    const first = createRepairRequestMock.mock.calls[0][0].recordUuid;

    act(() => {
      result.current.restartSubmission();
    });
    expect(result.current.submitError).toBeNull();
    expect(result.current.submitFailureReason).toBeNull();
    expect(result.current.attachment.status).toBe('idle');

    await act(async () => {
      await result.current.submit({ ...VALUES });
    });

    const second = createRepairRequestMock.mock.calls[1][0].recordUuid;
    expect(second).toMatch(UUID_PATTERN);
    expect(second).not.toBe(first);
  });
});

describe('提交守卫与机型模式（空目录手填）', () => {
  it('机型目录未就绪（加载中）时不发起创建请求', async () => {
    fetchModelsMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderFlow();

    await act(async () => {
      const record = await result.current.submit({ ...VALUES });
      expect(record).toBeNull();
    });
    expect(createRepairRequestMock).not.toHaveBeenCalled();
    expect(result.current.submitError).toBe('设备型号目录暂不可用，请稍后重试。');
  });

  it('机型目录加载失败时不发起创建请求（失败不得当作空目录）', async () => {
    fetchModelsMock.mockRejectedValue(
      new GraphQLIngressError({ type: 'network', message: 'down' }),
    );
    const { result } = renderFlow();
    await waitFor(() => expect(result.current.modelsState.status).toBe('failed'));

    await act(async () => {
      const record = await result.current.submit({ ...VALUES });
      expect(record).toBeNull();
    });
    expect(createRepairRequestMock).not.toHaveBeenCalled();
    expect(result.current.submitError).toBe('设备型号目录暂不可用，请稍后重试。');
  });

  it('厂家列表未就绪时不发起创建请求', async () => {
    fetchServiceOrgsMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderFlow();
    await waitFor(() => expect(result.current.modelsState.status).toBe('ready'));

    await act(async () => {
      const record = await result.current.submit({ ...VALUES });
      expect(record).toBeNull();
    });
    expect(createRepairRequestMock).not.toHaveBeenCalled();
    expect(result.current.submitError).toBe('维修厂家列表暂不可用，请稍后重试。');
  });

  it('手填模式纯空白机型不发起创建请求', async () => {
    const { result } = renderFlow();
    await waitFor(() => expect(result.current.modelsState.status).toBe('ready'));

    await act(async () => {
      const record = await result.current.submit(
        { ...VALUES, equipmentModelId: null, equipmentModelText: '   ' },
        { manualModel: true },
      );
      expect(record).toBeNull();
    });
    expect(createRepairRequestMock).not.toHaveBeenCalled();
    expect(result.current.submitError).toBe('请填写新机型');
  });

  it('选择模式未选择机型不发起创建请求', async () => {
    const { result } = renderFlow();
    await waitFor(() => expect(result.current.modelsState.status).toBe('ready'));

    await act(async () => {
      const record = await result.current.submit({ ...VALUES, equipmentModelId: null });
      expect(record).toBeNull();
    });
    expect(createRepairRequestMock).not.toHaveBeenCalled();
    expect(result.current.submitError).toBe('请选择设备型号');
  });

  it('选择模式载荷只携带 equipmentModelId，手填模式载荷只携带去空白的 equipmentModelText', async () => {
    createRepairRequestMock.mockResolvedValue({ ok: true, repairRequest: CREATED_RECORD });
    const { result } = renderFlow();
    await waitFor(() => expect(result.current.modelsState.status).toBe('ready'));

    await act(async () => {
      await result.current.submit({ ...VALUES });
    });
    const selectPayload = createRepairRequestMock.mock.calls[0][0];
    expect(selectPayload.equipmentModelId).toBe(11);
    expect('equipmentModelText' in selectPayload).toBe(false);

    await act(async () => {
      await result.current.submit(
        { ...VALUES, equipmentModelId: null, equipmentModelText: '  NSR-S622D  ' },
        { manualModel: true },
      );
    });
    const manualPayload = createRepairRequestMock.mock.calls[1][0];
    expect(manualPayload.equipmentModelText).toBe('NSR-S622D');
    expect('equipmentModelId' in manualPayload).toBe(false);
  });
});

describe('可信公司名称三态（PR #27 复审）', () => {
  it('不同公司账号分别得到各自的可信名称（ready）', async () => {
    fetchTrustedCompanyNameMock.mockResolvedValueOnce('甲公司');
    const first = renderFlow();
    await waitFor(() =>
      expect(first.result.current.companyState).toEqual({
        status: 'ready',
        trustedCompanyName: '甲公司',
      }),
    );
    first.unmount();

    // 第二个账号（服务端按会话身份返回另一家可信公司）
    fetchTrustedCompanyNameMock.mockResolvedValueOnce('乙公司');
    const second = renderFlow();
    await waitFor(() =>
      expect(second.result.current.companyState).toEqual({
        status: 'ready',
        trustedCompanyName: '乙公司',
      }),
    );
  });

  it('加载失败展示共享错误模型文案，重试恢复后显示可信名称', async () => {
    fetchTrustedCompanyNameMock
      .mockRejectedValueOnce(new GraphQLIngressError({ type: 'network', message: 'down' }))
      .mockResolvedValueOnce('甲公司');

    const { result } = renderFlow();

    await waitFor(() => expect(result.current.companyState.status).toBe('failed'));
    expect(
      result.current.companyState.status === 'failed' ? result.current.companyState.message : '',
    ).toBe('网络连接异常，请稍后重试。');

    await act(async () => {
      result.current.retryLoadCompany();
    });
    await waitFor(() =>
      expect(result.current.companyState).toEqual({
        status: 'ready',
        trustedCompanyName: '甲公司',
      }),
    );
  });

  it('未绑定公司：ready 且名称为 null，不展示虚构公司', async () => {
    fetchTrustedCompanyNameMock.mockResolvedValue(null);

    const { result } = renderFlow();

    await waitFor(() =>
      expect(result.current.companyState).toEqual({ status: 'ready', trustedCompanyName: null }),
    );
  });
});
