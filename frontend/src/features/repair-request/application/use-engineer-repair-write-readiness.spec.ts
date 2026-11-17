// src/features/repair-request/application/use-engineer-repair-write-readiness.spec.ts

/**
 * 工程师详情「未就绪写入口」回归（应用层）。
 *
 * 走真实 detail / flow / workbench hook，只 mock 外部 adapter，
 * 直接调用应用层写入口并断言 adapter 调用次数，而不是只检查按钮隐藏：
 * - 首载、切工单后、加载失败且无当前详情：回复 / 上传 / 过程新增编辑 / 结单一律 0 次；
 * - 旧工单或旧会话留下的迟到回调：0 次，且不改写当前页面；
 * - A 结单成功 → B → A（A 回读仍未结束）：A 为 0 次，B 按自身状态可写；
 *   实际采用已结束详情后 A 仍不可写；
 * - 同工单静默回读在途：只要仍有可用详情，不因后台请求在途而一律禁写；
 * - 详情正常就绪：对应 adapter 正常调用，避免把功能一并锁死。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AcceptRepairRequestResult,
  CloseRepairRequestResult,
  CreateEngineerResponseResult,
  EngineerRepairProcessEntry,
  EngineerRepairRequestDetail,
  EngineerRepairRequestDetailResult,
  RepairProcessWriteResult,
  StagedRepairProcessFile,
  UploadRepairProcessFileResult,
} from '../infrastructure/engineer-repair-request.types';
import * as engineerRepairRequestAdapter from '../infrastructure/engineer-repair-request-adapter';

import { resetRepairRequestClosureBarriersForTests } from './repair-request-closure-barrier';
import type { RepairProcessFormInput } from './use-engineer-repair-process-workbench';
import { useEngineerRepairProcessWorkbench } from './use-engineer-repair-process-workbench';
import { useEngineerRepairRequestDetailFlow } from './use-engineer-repair-request-detail-flow';

vi.mock('../infrastructure/engineer-repair-request-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof engineerRepairRequestAdapter>();

  return {
    ...actual,
    fetchEngineerRepairRequestDetail: vi.fn(),
    acceptRepairRequest: vi.fn(),
    createEngineerResponse: vi.fn(),
    uploadRepairProcessFile: vi.fn(),
    createRepairProcessEntry: vi.fn(),
    updateRepairProcessEntry: vi.fn(),
    closeRepairRequest: vi.fn(),
    downloadRepairProcessFile: vi.fn(),
  };
});

const fetchMock = vi.mocked(engineerRepairRequestAdapter.fetchEngineerRepairRequestDetail);
const createResponseMock = vi.mocked(engineerRepairRequestAdapter.createEngineerResponse);
const acceptMock = vi.mocked(engineerRepairRequestAdapter.acceptRepairRequest);
const uploadMock = vi.mocked(engineerRepairRequestAdapter.uploadRepairProcessFile);
const createProcessMock = vi.mocked(engineerRepairRequestAdapter.createRepairProcessEntry);
const updateProcessMock = vi.mocked(engineerRepairRequestAdapter.updateRepairProcessEntry);
const closeMock = vi.mocked(engineerRepairRequestAdapter.closeRepairRequest);

const PROCESS_ENTRY: EngineerRepairProcessEntry = {
  id: '101',
  entryUuid: '4f0c5f6a-1111-4111-8111-111111111111',
  requestId: 21,
  operationText: '服务端已有过程',
  testResult: null,
  occurredAt: null,
  timeSource: 'SERVER',
  fileId: null,
  file: null,
  versionNo: 1,
  createdAt: '2026-11-16T02:10:00.000Z',
};

const STAGED_FILE: StagedRepairProcessFile = {
  fileId: 'file-1',
  uploadContextId: 'ctx-1',
  originalFilename: 'report.pdf',
  mimeType: 'application/pdf',
  byteSize: 3,
  checksumSha256: 'abc',
};

const RESPONSE: CreateEngineerResponseResult = {
  ok: true,
  response: {
    id: 501,
    engineerNickname: '陈工',
    resolutionStatus: 'RESOLVED',
    responseText: '已更换备件',
    createdAt: '2026-11-16T04:00:00.000Z',
  },
};

const UPLOAD_OK: UploadRepairProcessFileResult = { ok: true, file: STAGED_FILE };
const PROCESS_OK: RepairProcessWriteResult = { ok: true, entry: PROCESS_ENTRY };
const CLOSE_OK: CloseRepairRequestResult = {
  ok: true,
  closure: {
    requestId: 21,
    closureStatus: 'CLOSED',
    closedAt: '2026-11-16T04:00:00.000Z',
    closureReason: null,
    handlingResult: 'FIXED',
    handlingStatus: 'COMPLETED',
    handlingEndedAt: '2026-11-16T03:30:00.000Z',
  },
};

const PROCESS_INPUT: RepairProcessFormInput = {
  operationText: '更换干涉仪镜片',
  testResult: null,
  occurredAt: null,
};

const RESPONSE_INPUT = {
  requestId: 21,
  responseText: '不应写入',
  resolutionStatus: 'RESOLVED' as const,
};

function buildDetail(
  id: number,
  marker: string,
  overrides: Partial<EngineerRepairRequestDetail> = {},
): EngineerRepairRequestDetail {
  return {
    id,
    requestNo: marker,
    equipmentModel: { id: 1, modelCode: 'LITHO-100', modelName: '光刻机 100' },
    errorCode: 'E-100',
    faultDescription: '设备无法启动',
    contentMd: '# 维修申请',
    createdAt: '2026-09-02T08:00:00.000Z',
    isAccepted: true,
    acceptedAt: '2026-09-02T08:30:00.000Z',
    latestResolutionStatus: null,
    customerNickname: '林客户',
    customerCompanyName: '林氏精密制造',
    acceptanceViewStatus: 'MINE',
    acceptedEngineerNickname: '陈工',
    closureStatus: null,
    closedAt: null,
    closureReason: null,
    handlingResult: null,
    handlingStatus: 'IN_PROGRESS',
    processEntries: [],
    responses: [],
    ...overrides,
  };
}

function detailOk(detail: EngineerRepairRequestDetail): EngineerRepairRequestDetailResult {
  return { ok: true, detail };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function useWriteHarness({ id, scopeKey = 'default' }: { id: number | null; scopeKey?: string }) {
  const flow = useEngineerRepairRequestDetailFlow(id, scopeKey);
  const workbench = useEngineerRepairProcessWorkbench(id, flow.reload, {
    scopeKey,
    writeEligible: flow.canWriteRequest,
  });
  return { flow, workbench };
}

type Workbench = ReturnType<typeof useWriteHarness>['workbench'];

async function callUpload(workbench: Workbench) {
  await act(async () => {
    await workbench.uploadFile(new File(['abc'], 'report.pdf', { type: 'application/pdf' }));
  });
}

async function callCreateProcess(workbench: Workbench) {
  await act(async () => {
    await workbench.saveProcess(PROCESS_INPUT, null);
  });
}

async function callEditProcess(workbench: Workbench) {
  await act(async () => {
    await workbench.saveProcess(PROCESS_INPUT, PROCESS_ENTRY);
  });
}

async function callClose(workbench: Workbench) {
  await act(async () => {
    await workbench.closeRequest('FIXED', null);
  });
}

async function callAllWrites(workbench: Workbench) {
  await callUpload(workbench);
  await callCreateProcess(workbench);
  await callEditProcess(workbench);
  await callClose(workbench);
}

async function callAccept(flow: ReturnType<typeof useWriteHarness>['flow']) {
  await act(async () => {
    await flow.accept();
  });
}

function expectNoWriteAdapters() {
  expect(createResponseMock).not.toHaveBeenCalled();
  expect(uploadMock).not.toHaveBeenCalled();
  expect(createProcessMock).not.toHaveBeenCalled();
  expect(updateProcessMock).not.toHaveBeenCalled();
  expect(closeMock).not.toHaveBeenCalled();
  expect(acceptMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  resetRepairRequestClosureBarriersForTests();
  fetchMock.mockReset();
  createResponseMock.mockReset().mockResolvedValue(RESPONSE);
  acceptMock.mockReset().mockImplementation((requestId: number) =>
    Promise.resolve({
      ok: true,
      detail: buildDetail(requestId, 'ACCEPTED', { acceptanceViewStatus: 'MINE' }),
    } satisfies AcceptRepairRequestResult),
  );
  uploadMock.mockReset().mockResolvedValue(UPLOAD_OK);
  createProcessMock.mockReset().mockResolvedValue(PROCESS_OK);
  updateProcessMock.mockReset().mockResolvedValue(PROCESS_OK);
  closeMock.mockReset().mockResolvedValue(CLOSE_OK);
});

describe('回复入口：详情未就绪时拒绝写入', () => {
  it('首载仍在加载：直接调用回复应用层入口为 0 次 adapter', async () => {
    fetchMock.mockReturnValue(never());
    const { result } = renderHook(() => useEngineerRepairRequestDetailFlow(21));
    expect(result.current.state.status).toBe('loading');

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.createResponse(RESPONSE_INPUT);
    });

    expect(outcome).toBeNull();
    expect(createResponseMock).not.toHaveBeenCalled();
  });

  it('加载失败且无当前详情：回复应用层入口为 0 次 adapter', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      reason: 'load-failed',
      message: '加载失败',
    } satisfies EngineerRepairRequestDetailResult);

    const { result } = renderHook(() => useEngineerRepairRequestDetailFlow(21));
    await waitFor(() => expect(result.current.state.status).toBe('failed'));

    await act(async () => {
      expect(await result.current.createResponse(RESPONSE_INPUT)).toBeNull();
    });
    expect(createResponseMock).not.toHaveBeenCalled();
  });

  it('切工单后新详情未就绪：当前入口与旧工单迟到回调均为 0 次', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'A-OPEN')));
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) => useEngineerRepairRequestDetailFlow(id),
      { initialProps: { id: 21 } },
    );
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const staleCreateResponse = result.current.createResponse;
    fetchMock.mockReturnValueOnce(never());
    rerender({ id: 22 });
    await waitFor(() => expect(result.current.state.status).toBe('loading'));

    await act(async () => {
      expect(await result.current.createResponse({ ...RESPONSE_INPUT, requestId: 22 })).toBeNull();
    });
    await act(async () => {
      expect(await staleCreateResponse(RESPONSE_INPUT)).toBeNull();
    });

    expect(createResponseMock).not.toHaveBeenCalled();
  });

  it('旧会话留下的回调为 0 次；当前会话按自身状态仍可写', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'A-OPEN')));
    const { result, rerender } = renderHook(
      ({ scopeKey }: { scopeKey: string }) => useEngineerRepairRequestDetailFlow(21, scopeKey),
      { initialProps: { scopeKey: 'session-a' } },
    );
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const staleCreateResponse = result.current.createResponse;
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'A-SESSION-B')));
    rerender({ scopeKey: 'session-b' });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        status: 'ready',
        detail: expect.objectContaining({ requestNo: 'A-SESSION-B' }),
      }),
    );

    await act(async () => {
      expect(await staleCreateResponse(RESPONSE_INPUT)).toBeNull();
    });
    expect(createResponseMock).not.toHaveBeenCalled();

    await act(async () => {
      expect(await result.current.createResponse(RESPONSE_INPUT)).toEqual(RESPONSE);
    });
    expect(createResponseMock).toHaveBeenCalledTimes(1);
  });
});

describe('回复入口：A 结单成功 → B → A 的工单边界', () => {
  it('A 回读仍未结束或已采用结束详情时均不可写，B 按自身状态可写', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'A-OPEN')));
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) => useEngineerRepairRequestDetailFlow(id),
      { initialProps: { id: 21 } },
    );
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    act(() => {
      result.current.markClosureSucceeded();
    });
    await waitFor(() => expect(result.current.closureBarrier).toBe(true));

    // B 不继承 A 的屏障，按自身就绪详情正常写入。
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(22, 'B-OPEN')));
    rerender({ id: 22 });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        status: 'ready',
        detail: expect.objectContaining({ requestNo: 'B-OPEN' }),
      }),
    );

    await act(async () => {
      expect(await result.current.createResponse({ ...RESPONSE_INPUT, requestId: 22 })).toEqual(
        RESPONSE,
      );
    });
    expect(createResponseMock).toHaveBeenCalledTimes(1);

    // 返回 A：回读仍未结束，屏障仍在，A 不可写。
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'A-READBACK-OPEN')));
    rerender({ id: 21 });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        status: 'ready',
        detail: expect.objectContaining({ requestNo: 'A-READBACK-OPEN' }),
      }),
    );
    expect(result.current.closureBarrier).toBe(true);

    await act(async () => {
      expect(await result.current.createResponse(RESPONSE_INPUT)).toBeNull();
    });
    expect(createResponseMock).toHaveBeenCalledTimes(1);

    // 实际采用已结束详情后，服务端事实接管只读，A 仍不可写。
    fetchMock.mockResolvedValueOnce(
      detailOk(buildDetail(21, 'A-CLOSED', { closureStatus: 'CLOSED' })),
    );
    await act(async () => {
      expect(await result.current.reload()).toMatchObject({ ok: true });
    });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        status: 'ready',
        detail: expect.objectContaining({ requestNo: 'A-CLOSED' }),
      }),
    );

    await act(async () => {
      expect(await result.current.createResponse(RESPONSE_INPUT)).toBeNull();
    });
    expect(createResponseMock).toHaveBeenCalledTimes(1);
  });
});

describe('回复入口：同工单静默回读在途', () => {
  it('仍有可用详情时不因后台回读在途而禁写', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'INITIAL')));
    const { result } = renderHook(() => useEngineerRepairRequestDetailFlow(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const silent = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(silent.promise);
    let reloadPromise!: Promise<unknown>;
    act(() => {
      reloadPromise = result.current.reload({ silent: true });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.state.status).toBe('ready');

    await act(async () => {
      expect(await result.current.createResponse(RESPONSE_INPUT)).toEqual(RESPONSE);
    });
    expect(createResponseMock).toHaveBeenCalledTimes(1);

    silent.resolve(detailOk(buildDetail(21, 'SILENT-REFRESH')));
    await act(async () => {
      await reloadPromise;
    });
  });
});

describe('过程 / 结单入口：详情未就绪时拒绝写入', () => {
  it('首载仍在加载：上传、过程新增、过程编辑、结单均为 0 次 adapter', async () => {
    fetchMock.mockReturnValue(never());
    const { result } = renderHook(() => useWriteHarness({ id: 21 }));
    expect(result.current.flow.state.status).toBe('loading');

    await callAllWrites(result.current.workbench);

    expectNoWriteAdapters();
  });

  it('加载失败且无当前详情：上传、过程新增、过程编辑、结单均为 0 次 adapter', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      reason: 'load-failed',
      message: '加载失败',
    } satisfies EngineerRepairRequestDetailResult);
    const { result } = renderHook(() => useWriteHarness({ id: 21 }));
    await waitFor(() => expect(result.current.flow.state.status).toBe('failed'));

    await callAllWrites(result.current.workbench);

    expectNoWriteAdapters();
  });

  it('切工单后新详情未就绪：当前入口与旧工单迟到回调均为 0 次', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'A-OPEN')));
    const { result, rerender } = renderHook(({ id }: { id: number }) => useWriteHarness({ id }), {
      initialProps: { id: 21 },
    });
    await waitFor(() => expect(result.current.flow.state.status).toBe('ready'));

    const staleWorkbench = result.current.workbench;
    fetchMock.mockReturnValueOnce(never());
    rerender({ id: 22 });
    await waitFor(() => expect(result.current.flow.state.status).toBe('loading'));

    await callAllWrites(result.current.workbench);
    await callAllWrites(staleWorkbench);

    expectNoWriteAdapters();
    expect(result.current.flow.state.status).toBe('loading');
  });

  it('旧会话留下的回调为 0 次；当前会话正常就绪的上传可写', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'A-OPEN')));
    const { result, rerender } = renderHook(
      ({ scopeKey }: { scopeKey: string }) => useWriteHarness({ id: 21, scopeKey }),
      { initialProps: { scopeKey: 'session-a' } },
    );
    await waitFor(() => expect(result.current.flow.state.status).toBe('ready'));

    const staleWorkbench = result.current.workbench;
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'A-SESSION-B')));
    rerender({ scopeKey: 'session-b' });
    await waitFor(() =>
      expect(result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: expect.objectContaining({ requestNo: 'A-SESSION-B' }),
      }),
    );

    await callAllWrites(staleWorkbench);
    expectNoWriteAdapters();

    await callUpload(result.current.workbench);
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });
});

describe('过程 / 结单入口：A 结单成功 → B → A 的工单边界', () => {
  it('A 屏障期间不可写，B 按自身状态可写；A 采用结束详情后仍不可写', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'A-OPEN')));
    const { result, rerender } = renderHook(({ id }: { id: number }) => useWriteHarness({ id }), {
      initialProps: { id: 21 },
    });
    await waitFor(() => expect(result.current.flow.state.status).toBe('ready'));

    act(() => {
      result.current.flow.markClosureSucceeded();
    });
    await waitFor(() => expect(result.current.flow.closureBarrier).toBe(true));

    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(22, 'B-OPEN')));
    rerender({ id: 22 });
    await waitFor(() =>
      expect(result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: expect.objectContaining({ requestNo: 'B-OPEN' }),
      }),
    );

    await callUpload(result.current.workbench);
    expect(uploadMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'A-READBACK-OPEN')));
    rerender({ id: 21 });
    await waitFor(() =>
      expect(result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: expect.objectContaining({ requestNo: 'A-READBACK-OPEN' }),
      }),
    );
    expect(result.current.flow.closureBarrier).toBe(true);

    await callAllWrites(result.current.workbench);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(createProcessMock).not.toHaveBeenCalled();
    expect(updateProcessMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(
      detailOk(buildDetail(21, 'A-CLOSED', { closureStatus: 'CLOSED' })),
    );
    await act(async () => {
      expect(await result.current.flow.reload()).toMatchObject({ ok: true });
    });
    await waitFor(() =>
      expect(result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: expect.objectContaining({ requestNo: 'A-CLOSED' }),
      }),
    );

    await callAllWrites(result.current.workbench);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(createProcessMock).not.toHaveBeenCalled();
    expect(updateProcessMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });
});

describe('六入口：会话代次 × 工单 × 实例生命周期的真实挂载交错', () => {
  it('同账号同工单换会话：立即重新读取；新详情采用前六个入口均不触达 adapter', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'SESSION-A')));
    const { result, rerender } = renderHook(
      ({ scopeKey }: { scopeKey: string }) => useWriteHarness({ id: 21, scopeKey }),
      { initialProps: { scopeKey: 'session-a' } },
    );
    await waitFor(() => expect(result.current.flow.state.status).toBe('ready'));

    const stale = result.current;
    const fresh = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(fresh.promise);
    rerender({ scopeKey: 'session-b' });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.flow.state.status).toBe('loading');

    await act(async () => {
      await stale.flow.createResponse(RESPONSE_INPUT);
      await stale.flow.accept();
    });
    await callAllWrites(stale.workbench);
    await act(async () => {
      await result.current.flow.createResponse(RESPONSE_INPUT);
      await result.current.flow.accept();
    });
    await callAllWrites(result.current.workbench);
    expectNoWriteAdapters();

    // 新会话详情实际采用后才恢复写入
    await act(async () => {
      fresh.resolve(detailOk(buildDetail(21, 'SESSION-B')));
    });
    await waitFor(() =>
      expect(result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: expect.objectContaining({ requestNo: 'SESSION-B' }),
      }),
    );
    await act(async () => {
      expect(await result.current.flow.createResponse(RESPONSE_INPUT)).toEqual(RESPONSE);
    });
    await callUpload(result.current.workbench);
    expect(createResponseMock).toHaveBeenCalledTimes(1);
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it('新会话就绪后旧会话详情迟到：旧回调零调用，新详情/反馈/busy 不变', async () => {
    const oldRead = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(oldRead.promise);
    const { result, rerender } = renderHook(
      ({ scopeKey }: { scopeKey: string }) => useWriteHarness({ id: 21, scopeKey }),
      { initialProps: { scopeKey: 'session-a' } },
    );
    expect(result.current.flow.state.status).toBe('loading');
    const stale = result.current;

    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'SESSION-B')));
    rerender({ scopeKey: 'session-b' });
    await waitFor(() =>
      expect(result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: expect.objectContaining({ requestNo: 'SESSION-B' }),
      }),
    );
    const beforeState = result.current.flow.state;
    const beforeResponseResult = result.current.flow.lastCreateResponseResult;

    await act(async () => {
      oldRead.resolve(detailOk(buildDetail(21, 'SESSION-A-LATE')));
    });
    await act(async () => {
      await stale.flow.createResponse(RESPONSE_INPUT);
      await stale.flow.accept();
    });
    await callAllWrites(stale.workbench);

    expectNoWriteAdapters();
    expect(result.current.flow.state).toEqual(beforeState);
    expect(result.current.flow.lastCreateResponseResult).toBe(beforeResponseResult);
    expect(result.current.workbench.saving).toBe(false);
    expect(result.current.workbench.uploading).toBe(false);
    expect(result.current.workbench.closing).toBe(false);
  });

  it('卸载 A、B 就绪后调用 A 旧回调；卸载后重开同一 A 均不误发（回复/接单）', async () => {
    fetchMock.mockResolvedValueOnce(
      detailOk(
        buildDetail(21, 'A-AVAILABLE', { isAccepted: false, acceptanceViewStatus: 'AVAILABLE' }),
      ),
    );
    const a = renderHook(() => useWriteHarness({ id: 21, scopeKey: 'session-a' }));
    await waitFor(() => expect(a.result.current.flow.state.status).toBe('ready'));
    const aFlow = a.result.current.flow;
    const aWorkbench = a.result.current.workbench;
    a.unmount();

    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(22, 'B-OPEN')));
    const b = renderHook(() => useWriteHarness({ id: 22, scopeKey: 'session-b' }));
    await waitFor(() =>
      expect(b.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: expect.objectContaining({ requestNo: 'B-OPEN' }),
      }),
    );
    const bState = b.result.current.flow.state;

    await act(async () => {
      await aFlow.createResponse(RESPONSE_INPUT);
      await aFlow.accept();
    });
    await callAllWrites(aWorkbench);
    expectNoWriteAdapters();
    expect(b.result.current.flow.state).toEqual(bState);

    b.unmount();

    // 卸载后重开同一工单 A：旧 A 回调仍不得命中新实例
    fetchMock.mockResolvedValueOnce(
      detailOk(
        buildDetail(21, 'A-REOPENED', { isAccepted: false, acceptanceViewStatus: 'AVAILABLE' }),
      ),
    );
    const reopened = renderHook(() => useWriteHarness({ id: 21, scopeKey: 'session-a' }));
    await waitFor(() =>
      expect(reopened.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: expect.objectContaining({ requestNo: 'A-REOPENED' }),
      }),
    );

    await act(async () => {
      await aFlow.createResponse(RESPONSE_INPUT);
      await aFlow.accept();
    });
    await callAllWrites(aWorkbench);
    expectNoWriteAdapters();

    // 新实例按自身就绪详情正常接单一次
    await callAccept(reopened.result.current.flow);
    expect(acceptMock).toHaveBeenCalledTimes(1);
  });

  it('当前实例与详情就绪：接单按自身条件正常调用一次', async () => {
    fetchMock.mockResolvedValueOnce(
      detailOk(
        buildDetail(21, 'AVAILABLE', { isAccepted: false, acceptanceViewStatus: 'AVAILABLE' }),
      ),
    );
    const { result } = renderHook(() => useEngineerRepairRequestDetailFlow(21, 'session-a'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    await callAccept(result.current);
    expect(acceptMock).toHaveBeenCalledTimes(1);
  });
});

describe('过程 / 结单入口：正常就绪时保持可用', () => {
  it('上传、过程新增、过程编辑、结单各自正常调用一次 adapter', async () => {
    fetchMock.mockResolvedValue(detailOk(buildDetail(21, 'READY')));
    const { result } = renderHook(() => useWriteHarness({ id: 21 }));
    await waitFor(() => expect(result.current.flow.state.status).toBe('ready'));

    await callUpload(result.current.workbench);
    expect(uploadMock).toHaveBeenCalledTimes(1);

    await callCreateProcess(result.current.workbench);
    expect(createProcessMock).toHaveBeenCalledTimes(1);

    await callEditProcess(result.current.workbench);
    expect(updateProcessMock).toHaveBeenCalledTimes(1);

    await callClose(result.current.workbench);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
