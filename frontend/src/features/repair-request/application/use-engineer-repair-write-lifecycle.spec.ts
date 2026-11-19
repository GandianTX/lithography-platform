// src/features/repair-request/application/use-engineer-repair-write-readiness.spec.ts

/**
 * 任务 04 写操作完整生命周期回归（应用层）。
 *
 * 验收单位是一条写操作的完整生命周期，而不是单个报错点：
 * 发起前归属检查 → 在途忙锁归属 → 完成后副作用归属 → 屏障解除所依据的采用身份。
 * 走真实 detail / flow / workbench hook，只 mock 外部 adapter 与列表失效监听，
 * 用可控 Promise 编排交错，不使用固定 sleep。
 *
 * 覆盖六类写入口：回复、接单、上传、过程新增、过程编辑、结单。
 * 每类入口都检查两个边界：
 * - 旧回调在提交前被拒绝（0 次 adapter）；
 * - 已发出的请求迟到后无客户端副作用（不写反馈/草稿/页面、不新增回读、
 *   不宣告列表失效、不建立或清除新归属的屏障）。
 *
 * 预置 B 屏障的用例是受控反例，用于固定「旧 ready 数据不得被当前 scopeKey
 * 重新归属」的规则，不声称生产路径必然以该顺序触发。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

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
    // 与详情页一致：结单成功建立本地屏障，只有采用已结束详情才撤销
    onCloseSucceeded: flow.markClosureSucceeded,
    onCloseReadbackSucceeded: flow.markClosureReadbackSucceeded,
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
    await workbench.closeRequest('FIXED', null, 0);
  });
}

async function callAllWrites(workbench: Workbench) {
  await callUpload(workbench);
  await callCreateProcess(workbench);
  await callEditProcess(workbench);
  await callClose(workbench);
}

function expectNoWriteAdapters() {
  expect(createResponseMock).not.toHaveBeenCalled();
  expect(uploadMock).not.toHaveBeenCalled();
  expect(createProcessMock).not.toHaveBeenCalled();
  expect(updateProcessMock).not.toHaveBeenCalled();
  expect(closeMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  resetRepairRequestClosureBarriersForTests();
  fetchMock.mockReset();
  createResponseMock.mockReset().mockResolvedValue(RESPONSE);
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

describe('independent stale callbacks after new target ready', () => {
  it('unmounted old flow cannot issue reply after new target is ready', async () => {
    fetchMock.mockResolvedValue(detailOk(buildDetail(21, 'A-OPEN')));
    const old = renderHook(() => useWriteHarness({ id: 21, scopeKey: 'session-a' }));
    await waitFor(() => expect(old.result.current.flow.state.status).toBe('ready'));
    const staleReply = old.result.current.flow.createResponse;
    const staleWorkbench = old.result.current.workbench;
    old.unmount();
    fetchMock.mockResolvedValue(detailOk(buildDetail(22, 'B-OPEN')));
    const next = renderHook(() => useWriteHarness({ id: 22, scopeKey: 'session-b' }));
    await waitFor(() =>
      expect(next.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'B-OPEN' },
      }),
    );
    await act(async () => {
      await staleReply(RESPONSE_INPUT);
    });
    await callAllWrites(staleWorkbench);
    expect(next.result.current.flow.state).toMatchObject({
      status: 'ready',
      detail: { requestNo: 'B-OPEN' },
    });
    expectNoWriteAdapters();
  });
  it('same account new session cannot reuse prior session detail before a fresh read', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'SESSION-A')));
    const h = renderHook(({ scopeKey }) => useWriteHarness({ id: 21, scopeKey }), {
      initialProps: { scopeKey: 'session-a' },
    });
    await waitFor(() => expect(h.result.current.flow.state.status).toBe('ready'));
    fetchMock.mockReturnValueOnce(never());
    h.rerender({ scopeKey: 'session-b' });
    await act(async () => {
      await h.result.current.flow.createResponse(RESPONSE_INPUT);
    });
    expect(createResponseMock).not.toHaveBeenCalled();
  });
});

describe('independent accept stale callback', () => {
  it('an unmounted old target does not issue accept after another target is ready', async () => {
    fetchMock.mockResolvedValue(
      detailOk(
        buildDetail(21, 'A-AVAILABLE', { isAccepted: false, acceptanceViewStatus: 'AVAILABLE' }),
      ),
    );
    const old = renderHook(() => useEngineerRepairRequestDetailFlow(21, 'session-a'));
    await waitFor(() => expect(old.result.current.state.status).toBe('ready'));
    const staleAccept = old.result.current.accept;
    old.unmount();
    fetchMock.mockResolvedValue(detailOk(buildDetail(22, 'B-OPEN')));
    const next = renderHook(() => useEngineerRepairRequestDetailFlow(22, 'session-b'));
    await waitFor(() =>
      expect(next.result.current.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'B-OPEN' },
      }),
    );
    vi.mocked(engineerRepairRequestAdapter.acceptRepairRequest).mockResolvedValue({
      ok: false,
      reason: 'insufficient-permission',
      message: 'diagnostic',
    });
    await act(async () => {
      await staleAccept();
    });
    expect(engineerRepairRequestAdapter.acceptRepairRequest).not.toHaveBeenCalled();
  });
});

describe('independent ready-target isolation', () => {
  it('old callbacks after B is ready issue no adapters and leave B state intact', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'A-OPEN')));
    const h = renderHook(({ id }) => useWriteHarness({ id, scopeKey: 'session-a' }), {
      initialProps: { id: 21 },
    });
    await waitFor(() => expect(h.result.current.flow.state.status).toBe('ready'));
    const oldFlow = h.result.current.flow;
    const oldWorkbench = h.result.current.workbench;
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(22, 'B-OPEN')));
    h.rerender({ id: 22 });
    await waitFor(() =>
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'B-OPEN' },
      }),
    );
    await act(async () => {
      await oldFlow.createResponse(RESPONSE_INPUT);
    });
    await callAllWrites(oldWorkbench);
    expectNoWriteAdapters();
    expect(h.result.current.flow.state).toMatchObject({
      status: 'ready',
      detail: { requestNo: 'B-OPEN' },
    });
    expect(h.result.current.workbench.saving).toBe(false);
    expect(h.result.current.workbench.uploading).toBe(false);
    expect(h.result.current.workbench.closing).toBe(false);
  });
});

describe('independent unmounted workbench', () => {
  it('old workbench calls remain blocked after a new target is ready', async () => {
    fetchMock.mockResolvedValue(detailOk(buildDetail(21, 'A-OPEN')));
    const old = renderHook(() => useWriteHarness({ id: 21, scopeKey: 'session-a' }));
    await waitFor(() => expect(old.result.current.flow.state.status).toBe('ready'));
    const stale = old.result.current.workbench;
    old.unmount();
    fetchMock.mockResolvedValue(detailOk(buildDetail(22, 'B-OPEN')));
    const next = renderHook(() => useWriteHarness({ id: 22, scopeKey: 'session-b' }));
    await waitFor(() =>
      expect(next.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'B-OPEN' },
      }),
    );
    await callAllWrites(stale);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(createProcessMock).not.toHaveBeenCalled();
    expect(updateProcessMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
    expect(next.result.current.workbench.saving).toBe(false);
  });
});

import { onEngineerRepairListsInvalidated } from './engineer-repair-list-refresh';
import { useAcceptRepairRequest } from './use-accept-repair-request';

describe('independent r13 late request side effects', () => {
  it('old reply success after unmount must not invalidate current list', async () => {
    const late = deferred<CreateEngineerResponseResult>();
    createResponseMock.mockReturnValueOnce(late.promise);
    fetchMock.mockResolvedValue(detailOk(buildDetail(21, 'A-OPEN')));
    const old = renderHook(() => useWriteHarness({ id: 21, scopeKey: 'session-a' }));
    await waitFor(() => expect(old.result.current.flow.state.status).toBe('ready'));
    let pending!: Promise<unknown>;
    act(() => {
      pending = old.result.current.flow.createResponse(RESPONSE_INPUT);
    });
    expect(createResponseMock).toHaveBeenCalledTimes(1);
    old.unmount();
    fetchMock.mockResolvedValue(detailOk(buildDetail(22, 'B-OPEN')));
    const next = renderHook(() => useWriteHarness({ id: 22, scopeKey: 'session-b' }));
    await waitFor(() =>
      expect(next.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'B-OPEN' },
      }),
    );
    const listener = vi.fn();
    const unsubscribe = onEngineerRepairListsInvalidated(listener);
    try {
      await act(async () => {
        late.resolve(RESPONSE);
        await pending;
      });
      expect(next.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'B-OPEN' },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
  it('old accept success after scope switch must not invalidate current list', async () => {
    const late = deferred<AcceptRepairRequestResult>();
    vi.mocked(engineerRepairRequestAdapter.acceptRepairRequest)
      .mockReset()
      .mockReturnValueOnce(late.promise);
    fetchMock.mockResolvedValueOnce(
      detailOk(
        buildDetail(21, 'SESSION-A', { isAccepted: false, acceptanceViewStatus: 'AVAILABLE' }),
      ),
    );
    const h = renderHook(({ scopeKey }) => useWriteHarness({ id: 21, scopeKey }), {
      initialProps: { scopeKey: 'session-a' },
    });
    await waitFor(() => expect(h.result.current.flow.state.status).toBe('ready'));
    let pending!: Promise<unknown>;
    act(() => {
      pending = h.result.current.flow.accept();
    });
    expect(engineerRepairRequestAdapter.acceptRepairRequest).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(
      detailOk(
        buildDetail(21, 'SESSION-B', { isAccepted: false, acceptanceViewStatus: 'AVAILABLE' }),
      ),
    );
    h.rerender({ scopeKey: 'session-b' });
    await waitFor(() =>
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'SESSION-B' },
      }),
    );
    const listener = vi.fn();
    const unsubscribe = onEngineerRepairListsInvalidated(listener);
    try {
      await act(async () => {
        late.resolve({ ok: true, detail: buildDetail(21, 'OLD-ACCEPT') });
        await pending;
      });
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'SESSION-B' },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
  it('list accept hook refuses callback after unmount and suppresses a late success', async () => {
    const late = deferred<AcceptRepairRequestResult>();
    vi.mocked(engineerRepairRequestAdapter.acceptRepairRequest)
      .mockReset()
      .mockReturnValueOnce(late.promise);
    const hook = renderHook(() => useAcceptRepairRequest());
    const accept = hook.result.current.accept;
    let pending!: Promise<unknown>;
    act(() => {
      pending = accept(21);
    });
    expect(engineerRepairRequestAdapter.acceptRepairRequest).toHaveBeenCalledTimes(1);
    hook.unmount();
    const listener = vi.fn();
    const unsubscribe = onEngineerRepairListsInvalidated(listener);
    try {
      await act(async () => {
        late.resolve({ ok: true, detail: buildDetail(21, 'ACCEPTED') });
        await pending;
        await accept(22);
      });
      expect(engineerRepairRequestAdapter.acceptRepairRequest).toHaveBeenCalledTimes(1);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
  it('new session can reply after its detail is ready while old reply is still in flight', async () => {
    const late = deferred<CreateEngineerResponseResult>();
    createResponseMock.mockReturnValueOnce(late.promise);
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'SESSION-A')));
    const h = renderHook(({ scopeKey }) => useWriteHarness({ id: 21, scopeKey }), {
      initialProps: { scopeKey: 'session-a' },
    });
    await waitFor(() => expect(h.result.current.flow.state.status).toBe('ready'));
    let first!: Promise<unknown>;
    act(() => {
      first = h.result.current.flow.createResponse(RESPONSE_INPUT);
    });
    expect(createResponseMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'SESSION-B')));
    h.rerender({ scopeKey: 'session-b' });
    await waitFor(() =>
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'SESSION-B' },
      }),
    );
    await act(async () => {
      await h.result.current.flow.createResponse(RESPONSE_INPUT);
    });
    expect(createResponseMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      late.resolve(RESPONSE);
      await first;
    });
  });
});

import {
  hasRepairRequestClosureSucceeded,
  markRepairRequestClosureSucceeded,
} from './repair-request-closure-barrier';
describe('independent r13 adopted-detail barrier', () => {
  it('old session ended detail cannot clear a new session barrier before its pending read is adopted', async () => {
    fetchMock.mockResolvedValueOnce(
      detailOk(buildDetail(21, 'A-CLOSED', { closureStatus: 'CLOSED' })),
    );
    const h = renderHook(({ scopeKey }) => useWriteHarness({ id: 21, scopeKey }), {
      initialProps: { scopeKey: 'session-a' },
    });
    await waitFor(() =>
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'A-CLOSED' },
      }),
    );
    markRepairRequestClosureSucceeded('session-b', 21);
    fetchMock.mockReturnValueOnce(never());
    h.rerender({ scopeKey: 'session-b' });
    expect(h.result.current.flow.state.status).toBe('loading');
    expect(hasRepairRequestClosureSucceeded('session-b', 21)).toBe(true);
  });
});

describe('independent r13 barrier observable consequence', () => {
  it('a pending new session retains its barrier after old ended detail and blocks open readback', async () => {
    fetchMock.mockResolvedValueOnce(
      detailOk(buildDetail(21, 'A-CLOSED', { closureStatus: 'CLOSED' })),
    );
    const h = renderHook(({ scopeKey }) => useWriteHarness({ id: 21, scopeKey }), {
      initialProps: { scopeKey: 'session-a' },
    });
    await waitFor(() =>
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'A-CLOSED' },
      }),
    );
    markRepairRequestClosureSucceeded('session-b', 21);
    const fresh = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(fresh.promise);
    h.rerender({ scopeKey: 'session-b' });
    await act(async () => {
      fresh.resolve(detailOk(buildDetail(21, 'B-OPEN')));
    });
    await waitFor(() =>
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'B-OPEN' },
      }),
    );
    await act(async () => {
      await h.result.current.flow.createResponse(RESPONSE_INPUT);
    });
    expect(createResponseMock).not.toHaveBeenCalled();
  });
});

describe('回复忙锁：按「工单 + 会话」归属隔离', () => {
  it('A 在飞 → B 采用并提交 → A 先结束：2 次调用、B 仍忙、重复提交不产生第 3 次、B 结束才释放', async () => {
    const replyA = deferred<CreateEngineerResponseResult>();
    const replyB = deferred<CreateEngineerResponseResult>();
    createResponseMock.mockReturnValueOnce(replyA.promise).mockReturnValueOnce(replyB.promise);

    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'SESSION-A')));
    const h = renderHook(
      ({ scopeKey }: { scopeKey: string }) => useWriteHarness({ id: 21, scopeKey }),
      { initialProps: { scopeKey: 'session-a' } },
    );
    await waitFor(() =>
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'SESSION-A' },
      }),
    );

    let pendingA!: Promise<unknown>;
    act(() => {
      pendingA = h.result.current.flow.createResponse(RESPONSE_INPUT);
    });
    expect(createResponseMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'SESSION-B')));
    h.rerender({ scopeKey: 'session-b' });
    await waitFor(() =>
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'SESSION-B' },
      }),
    );
    // 旧会话在飞不阻塞新会话
    expect(h.result.current.flow.submitting).toBe(false);

    let pendingB!: Promise<unknown>;
    act(() => {
      pendingB = h.result.current.flow.createResponse(RESPONSE_INPUT);
    });
    expect(createResponseMock).toHaveBeenCalledTimes(2);
    expect(h.result.current.flow.submitting).toBe(true);

    // B 在飞时重复提交不产生第 3 次调用
    await act(async () => {
      expect(await h.result.current.flow.createResponse(RESPONSE_INPUT)).toBeNull();
    });
    expect(createResponseMock).toHaveBeenCalledTimes(2);

    // A 先结束不得清掉 B 的忙状态
    await act(async () => {
      replyA.resolve(RESPONSE);
      await pendingA;
    });
    expect(h.result.current.flow.submitting).toBe(true);

    await act(async () => {
      replyB.resolve(RESPONSE);
      await pendingB;
    });
    expect(h.result.current.flow.submitting).toBe(false);
  });

  it('B 先结束、A 后结束：B 的结果与忙状态保持，A 迟到不覆盖也不额外宣告失效', async () => {
    const replyA = deferred<CreateEngineerResponseResult>();
    const replyB = deferred<CreateEngineerResponseResult>();
    const responseB: CreateEngineerResponseResult = {
      ok: true,
      response: {
        ...RESPONSE.response,
        id: 502,
        responseText: 'B 的回复',
      },
    };
    createResponseMock.mockReturnValueOnce(replyA.promise).mockReturnValueOnce(replyB.promise);

    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'SESSION-A')));
    const h = renderHook(
      ({ scopeKey }: { scopeKey: string }) => useWriteHarness({ id: 21, scopeKey }),
      { initialProps: { scopeKey: 'session-a' } },
    );
    await waitFor(() =>
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'SESSION-A' },
      }),
    );

    let pendingA!: Promise<unknown>;
    act(() => {
      pendingA = h.result.current.flow.createResponse(RESPONSE_INPUT);
    });

    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'SESSION-B')));
    h.rerender({ scopeKey: 'session-b' });
    await waitFor(() =>
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'SESSION-B' },
      }),
    );

    let pendingB!: Promise<unknown>;
    act(() => {
      pendingB = h.result.current.flow.createResponse(RESPONSE_INPUT);
    });
    expect(createResponseMock).toHaveBeenCalledTimes(2);

    const listener = vi.fn();
    const unsubscribe = onEngineerRepairListsInvalidated(listener);
    try {
      await act(async () => {
        replyB.resolve(responseB);
        await pendingB;
      });
      expect(h.result.current.flow.submitting).toBe(false);
      expect(h.result.current.flow.lastCreateResponseResult).toEqual(responseB);
      expect(listener).toHaveBeenCalledTimes(1);

      await act(async () => {
        replyA.resolve(RESPONSE);
        await pendingA;
      });
      // A 迟到不得覆盖 B 的结果、不得再次宣告失效
      expect(h.result.current.flow.lastCreateResponseResult).toEqual(responseB);
      expect(h.result.current.flow.submitting).toBe(false);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'SESSION-B' },
      });
    } finally {
      unsubscribe();
    }
  });
});

describe('列表失效：只由当前归属的实际结果宣告', () => {
  it('当前会话的合法回复成功仍按原合同宣告一次列表失效', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'REPLY-READY')));
    const h = renderHook(() => useWriteHarness({ id: 21, scopeKey: 'session-a' }));
    await waitFor(() => expect(h.result.current.flow.state.status).toBe('ready'));

    const listener = vi.fn();
    const unsubscribe = onEngineerRepairListsInvalidated(listener);
    try {
      await act(async () => {
        expect(await h.result.current.flow.createResponse(RESPONSE_INPUT)).toEqual(RESPONSE);
      });
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('当前会话的合法接单成功仍按原合同宣告一次列表失效', async () => {
    vi.mocked(engineerRepairRequestAdapter.acceptRepairRequest)
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        detail: buildDetail(21, 'ACCEPTED', { acceptanceViewStatus: 'MINE' }),
      });
    fetchMock.mockResolvedValueOnce(
      detailOk(
        buildDetail(21, 'AVAILABLE', {
          isAccepted: false,
          acceptanceViewStatus: 'AVAILABLE',
        }),
      ),
    );
    const h = renderHook(() => useEngineerRepairRequestDetailFlow(21, 'session-a'));
    await waitFor(() => expect(h.result.current.state.status).toBe('ready'));

    const listener = vi.fn();
    const unsubscribe = onEngineerRepairListsInvalidated(listener);
    try {
      await act(async () => {
        expect(await h.result.current.accept()).toMatchObject({ ok: true });
      });
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });
});

describe('屏障：只由匹配且被采用的已结束详情解除', () => {
  it('B 采用未结束详情不清除预置屏障；采用自己的已结束详情后才由服务端事实接管', async () => {
    fetchMock.mockResolvedValueOnce(
      detailOk(buildDetail(21, 'A-CLOSED', { closureStatus: 'CLOSED' })),
    );
    const h = renderHook(
      ({ scopeKey }: { scopeKey: string }) => useWriteHarness({ id: 21, scopeKey }),
      { initialProps: { scopeKey: 'session-a' } },
    );
    await waitFor(() =>
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'A-CLOSED' },
      }),
    );

    // 受控反例：B 已登记屏障，而 A 的已结束详情仍在共享状态中
    markRepairRequestClosureSucceeded('session-b', 21);

    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'B-OPEN')));
    h.rerender({ scopeKey: 'session-b' });
    await waitFor(() =>
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'B-OPEN' },
      }),
    );

    // B 采用未结束详情：屏障保持，写入口继续拒绝
    expect(hasRepairRequestClosureSucceeded('session-b', 21)).toBe(true);
    await act(async () => {
      expect(await h.result.current.flow.createResponse(RESPONSE_INPUT)).toBeNull();
    });
    expect(createResponseMock).not.toHaveBeenCalled();

    // B 采用自己的已结束详情：才由服务端事实接管只读
    fetchMock.mockResolvedValueOnce(
      detailOk(buildDetail(21, 'B-CLOSED', { closureStatus: 'CLOSED' })),
    );
    await act(async () => {
      await h.result.current.flow.reload();
    });
    await waitFor(() =>
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'B-CLOSED' },
      }),
    );
    expect(hasRepairRequestClosureSucceeded('session-b', 21)).toBe(false);

    // 已结束详情接管后仍不可写（由结束状态而非屏障拒绝）
    await act(async () => {
      expect(await h.result.current.flow.createResponse(RESPONSE_INPUT)).toBeNull();
    });
    expect(createResponseMock).not.toHaveBeenCalled();
  });
});

describe('六类写入口：已发出请求迟到后的客户端副作用边界', () => {
  const WORKBENCH_WRITES: Array<{
    name: string;
    start: (workbench: Workbench) => Promise<unknown>;
    adapter: Mock;
    success: unknown;
  }> = [
    {
      name: '上传',
      start: (workbench) =>
        workbench.uploadFile(new File(['abc'], 'late.pdf', { type: 'application/pdf' })),
      adapter: uploadMock,
      success: UPLOAD_OK,
    },
    {
      name: '过程新增',
      start: (workbench) => workbench.saveProcess(PROCESS_INPUT, null),
      adapter: createProcessMock,
      success: PROCESS_OK,
    },
    {
      name: '过程编辑',
      start: (workbench) => workbench.saveProcess(PROCESS_INPUT, PROCESS_ENTRY),
      adapter: updateProcessMock,
      success: PROCESS_OK,
    },
    {
      name: '结单',
      start: (workbench) => workbench.closeRequest('FIXED', null, 0),
      adapter: closeMock,
      success: CLOSE_OK,
    },
  ];

  it.each(WORKBENCH_WRITES)(
    '$name 已发出后切换会话：迟到成功不写新页面、不新增回读、不建立新归属屏障',
    async ({ start, adapter, success }) => {
      const late = deferred<unknown>();
      adapter.mockReturnValueOnce(late.promise as never);

      fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'SESSION-A')));
      const h = renderHook(
        ({ scopeKey }: { scopeKey: string }) => useWriteHarness({ id: 21, scopeKey }),
        { initialProps: { scopeKey: 'session-a' } },
      );
      await waitFor(() =>
        expect(h.result.current.flow.state).toMatchObject({
          status: 'ready',
          detail: { requestNo: 'SESSION-A' },
        }),
      );

      let pending!: Promise<unknown>;
      act(() => {
        pending = start(h.result.current.workbench);
      });
      expect(adapter).toHaveBeenCalledTimes(1);

      // 切换会话并采用 B 的详情；A 的请求仍在途
      fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'SESSION-B')));
      h.rerender({ scopeKey: 'session-b' });
      await waitFor(() =>
        expect(h.result.current.flow.state).toMatchObject({
          status: 'ready',
          detail: { requestNo: 'SESSION-B' },
        }),
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await act(async () => {
        late.resolve(success);
        await pending;
      });

      // 迟到结果不写页面、不触发回读、不写入新会话的暂存/结果/屏障
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'SESSION-B' },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(h.result.current.workbench.stagedFile).toBeNull();
      expect(h.result.current.workbench.uploading).toBe(false);
      expect(h.result.current.workbench.saving).toBe(false);
      expect(h.result.current.workbench.closing).toBe(false);
      expect(h.result.current.workbench.lastProcessResult).toBeNull();
      expect(h.result.current.workbench.lastCloseResult).toBeNull();
      expect(hasRepairRequestClosureSucceeded('session-a', 21)).toBe(false);
      expect(hasRepairRequestClosureSucceeded('session-b', 21)).toBe(false);
    },
  );
});

describe('同工单静默回读不误禁写（过程入口）', () => {
  it('静默回读在途时上传仍可提交，不因后台请求禁用写入', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'INITIAL')));
    const h = renderHook(() => useWriteHarness({ id: 21 }));
    await waitFor(() => expect(h.result.current.flow.state.status).toBe('ready'));

    const silent = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(silent.promise);
    let reloadPromise!: Promise<unknown>;
    act(() => {
      reloadPromise = h.result.current.flow.reload({ silent: true });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(h.result.current.flow.state.status).toBe('ready');

    await callUpload(h.result.current.workbench);
    expect(uploadMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      silent.resolve(detailOk(buildDetail(21, 'SILENT-REFRESH')));
      await reloadPromise;
    });
  });
});

describe('结单防重：同一实例同一轮次只认一个结单令牌', () => {
  const CLOSE_FAILED: CloseRepairRequestResult = {
    ok: false,
    reason: 'close-failed',
    message: '结单失败，请稍后重试。',
  };

  it('同一实例同一轮次调用两次：第一条在途时 adapter 仅 1 次，拒绝第二条不释放 closing', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'CLOSE-TARGET')));
    const closeGate = deferred<CloseRepairRequestResult>();
    closeMock.mockReturnValueOnce(closeGate.promise);

    const h = renderHook(() => useWriteHarness({ id: 21 }));
    await waitFor(() => expect(h.result.current.flow.state.status).toBe('ready'));

    let first!: Promise<CloseRepairRequestResult | null>;
    let second!: Promise<CloseRepairRequestResult | null>;
    act(() => {
      first = h.result.current.workbench.closeRequest('FIXED', null, 0);
      second = h.result.current.workbench.closeRequest('FIXED', null, 0);
    });

    // 旧实现：第二条在同一事件轮次通过归属检查，实际触达 adapter 两次
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(h.result.current.workbench.closing).toBe(true);
    expect(h.result.current.workbench.lastCloseResult).toBeNull();

    await act(async () => {
      await expect(second).resolves.toBeNull();
    });
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(h.result.current.workbench.closing).toBe(true);
    expect(h.result.current.workbench.lastCloseResult).toBeNull();

    fetchMock.mockResolvedValueOnce(
      detailOk(buildDetail(21, 'CLOSE-TARGET', { closureStatus: 'CLOSED' })),
    );
    await act(async () => {
      closeGate.resolve(CLOSE_OK);
      await first;
    });

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(h.result.current.workbench.closing).toBe(false);
    expect(h.result.current.workbench.lastCloseResult).toEqual(CLOSE_OK);
  });

  it('当前结单失败后合法重试：仅当前令牌释放忙状态，重试可发出且不误建屏障', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'OPEN-AFTER-FAILURE')));
    const retryReadback = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(retryReadback.promise);
    closeMock.mockResolvedValueOnce(CLOSE_FAILED).mockResolvedValueOnce(CLOSE_OK);

    const h = renderHook(() => useWriteHarness({ id: 21 }));
    await waitFor(() => expect(h.result.current.flow.state.status).toBe('ready'));

    await act(async () => {
      await h.result.current.workbench.closeRequest('FIXED', null, 0);
    });

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(h.result.current.workbench.closing).toBe(false);
    expect(h.result.current.workbench.lastCloseResult).toEqual(CLOSE_FAILED);
    expect(hasRepairRequestClosureSucceeded('default', 21)).toBe(false);

    let retry!: Promise<CloseRepairRequestResult | null>;
    act(() => {
      retry = h.result.current.workbench.closeRequest('FIXED', null, 0);
    });
    await waitFor(() => expect(hasRepairRequestClosureSucceeded('default', 21)).toBe(true));
    expect(closeMock).toHaveBeenCalledTimes(2);
    expect(h.result.current.workbench.closing).toBe(true);

    await act(async () => {
      retryReadback.resolve(detailOk(buildDetail(21, 'CLOSE-TARGET', { closureStatus: 'CLOSED' })));
      await retry;
    });

    expect(h.result.current.workbench.closing).toBe(false);
    expect(h.result.current.workbench.lastCloseResult).toEqual(CLOSE_OK);
    expect(h.result.current.workbench.closeReadbackFailed).toBe(false);
  });

  it('当前结单成功、回读失败：忙锁释放后只读屏障仍生效，不恢复写入', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'OPEN-BEFORE-CLOSE')));
    const readback = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(readback.promise);
    closeMock.mockResolvedValueOnce(CLOSE_OK);

    const h = renderHook(() => useWriteHarness({ id: 21 }));
    await waitFor(() => expect(h.result.current.flow.state.status).toBe('ready'));

    let pending!: Promise<CloseRepairRequestResult | null>;
    act(() => {
      pending = h.result.current.workbench.closeRequest('FIXED', null, 0);
    });
    await waitFor(() => expect(hasRepairRequestClosureSucceeded('default', 21)).toBe(true));
    expect(h.result.current.workbench.closing).toBe(true);

    await act(async () => {
      readback.resolve({ ok: false, reason: 'load-failed', message: '网络连接异常，请稍后重试。' });
      await pending;
    });

    expect(h.result.current.workbench.closing).toBe(false);
    expect(h.result.current.workbench.closeReadbackFailed).toBe(true);
    expect(h.result.current.workbench.lastCloseResult).toEqual(CLOSE_OK);
    // 释放忙锁不等于撤销只读屏障
    expect(hasRepairRequestClosureSucceeded('default', 21)).toBe(true);
    expect(h.result.current.flow.canWriteRequest(21, 'default')).toBe(false);
  });

  it('旧会话结单在途、切会话后新结单已发出：旧结果先完成也不释放新锁、不写反馈、不触发回读', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'SESSION-A')));
    const closeA = deferred<CloseRepairRequestResult>();
    const closeB = deferred<CloseRepairRequestResult>();
    closeMock.mockReturnValueOnce(closeA.promise).mockReturnValueOnce(closeB.promise);

    const h = renderHook(
      ({ scopeKey }: { scopeKey: string }) => useWriteHarness({ id: 21, scopeKey }),
      {
        initialProps: { scopeKey: 'session-a' },
      },
    );
    await waitFor(() =>
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'SESSION-A' },
      }),
    );

    let pendingA!: Promise<CloseRepairRequestResult | null>;
    act(() => {
      pendingA = h.result.current.workbench.closeRequest('FIXED', null, 0);
    });
    expect(closeMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'SESSION-B')));
    h.rerender({ scopeKey: 'session-b' });
    await waitFor(() =>
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'SESSION-B' },
      }),
    );
    expect(h.result.current.workbench.closing).toBe(false);

    let pendingB!: Promise<CloseRepairRequestResult | null>;
    act(() => {
      pendingB = h.result.current.workbench.closeRequest('FIXED', null, 0);
    });
    expect(closeMock).toHaveBeenCalledTimes(2);
    expect(h.result.current.workbench.closing).toBe(true);

    const fetchCallsBeforeOldCompletes = fetchMock.mock.calls.length;
    await act(async () => {
      closeA.resolve(CLOSE_OK);
      await pendingA;
    });

    // 旧会话迟到结果：不清新会话忙锁、不写反馈、不追加回读、不登记旧会话屏障
    expect(h.result.current.workbench.closing).toBe(true);
    expect(h.result.current.workbench.lastCloseResult).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(fetchCallsBeforeOldCompletes);
    expect(hasRepairRequestClosureSucceeded('session-a', 21)).toBe(false);

    fetchMock.mockResolvedValueOnce(
      detailOk(buildDetail(21, 'SESSION-B-CLOSED', { closureStatus: 'CLOSED' })),
    );
    await act(async () => {
      closeB.resolve(CLOSE_OK);
      await pendingB;
    });

    expect(closeMock).toHaveBeenCalledTimes(2);
    expect(h.result.current.workbench.closing).toBe(false);
    expect(h.result.current.workbench.lastCloseResult).toEqual(CLOSE_OK);
    expect(hasRepairRequestClosureSucceeded('session-b', 21)).toBe(false);
  });

  it('新会话结单先完成、旧会话结单后完成：新结果与忙状态保持，旧结果不覆盖也不改屏障', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'SESSION-A')));
    const closeA = deferred<CloseRepairRequestResult>();
    const closeB = deferred<CloseRepairRequestResult>();
    closeMock.mockReturnValueOnce(closeA.promise).mockReturnValueOnce(closeB.promise);

    const h = renderHook(
      ({ scopeKey }: { scopeKey: string }) => useWriteHarness({ id: 21, scopeKey }),
      {
        initialProps: { scopeKey: 'session-a' },
      },
    );
    await waitFor(() =>
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'SESSION-A' },
      }),
    );

    let pendingA!: Promise<CloseRepairRequestResult | null>;
    act(() => {
      pendingA = h.result.current.workbench.closeRequest('FIXED', null, 0);
    });

    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'SESSION-B')));
    h.rerender({ scopeKey: 'session-b' });
    await waitFor(() =>
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'SESSION-B' },
      }),
    );

    let pendingB!: Promise<CloseRepairRequestResult | null>;
    act(() => {
      pendingB = h.result.current.workbench.closeRequest('FIXED', null, 0);
    });

    fetchMock.mockResolvedValueOnce(
      detailOk(buildDetail(21, 'SESSION-B-CLOSED', { closureStatus: 'CLOSED' })),
    );
    await act(async () => {
      closeB.resolve(CLOSE_OK);
      await pendingB;
    });
    expect(h.result.current.workbench.closing).toBe(false);
    expect(h.result.current.workbench.lastCloseResult).toEqual(CLOSE_OK);

    const fetchCallsBeforeOldCompletes = fetchMock.mock.calls.length;
    await act(async () => {
      closeA.resolve(CLOSE_OK);
      await pendingA;
    });

    expect(h.result.current.workbench.closing).toBe(false);
    expect(h.result.current.workbench.lastCloseResult).toEqual(CLOSE_OK);
    expect(fetchMock).toHaveBeenCalledTimes(fetchCallsBeforeOldCompletes);
    expect(hasRepairRequestClosureSucceeded('session-a', 21)).toBe(false);
    expect(hasRepairRequestClosureSucceeded('session-b', 21)).toBe(false);
  });
});

describe('independent r13 late detail outcomes', () => {
  it.each(['success', 'failure'])(
    'ignores old session %s after new session is ready',
    async (kind) => {
      const old = deferred<EngineerRepairRequestDetailResult>();
      fetchMock.mockReturnValueOnce(old.promise);
      const h = renderHook(({ scopeKey }) => useWriteHarness({ id: 21, scopeKey }), {
        initialProps: { scopeKey: 'session-a' },
      });
      expect(h.result.current.flow.state.status).toBe('loading');
      fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'B-READY')));
      h.rerender({ scopeKey: 'session-b' });
      await waitFor(() =>
        expect(h.result.current.flow.state).toMatchObject({
          status: 'ready',
          detail: { requestNo: 'B-READY' },
        }),
      );
      await act(async () => {
        old.resolve(
          kind === 'success'
            ? detailOk(buildDetail(21, 'OLD-LATE'))
            : { ok: false, reason: 'load-failed', message: 'old failure' },
        );
      });
      expect(h.result.current.flow.state).toMatchObject({
        status: 'ready',
        detail: { requestNo: 'B-READY' },
      });
      expect(h.result.current.flow.lastCreateResponseResult).toBeNull();
      expect(h.result.current.workbench.saving).toBe(false);
      expect(h.result.current.workbench.uploading).toBe(false);
      expect(h.result.current.workbench.closing).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
});
