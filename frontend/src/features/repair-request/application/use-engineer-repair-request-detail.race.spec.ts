// src/features/repair-request/application/use-engineer-repair-request-detail.race.spec.ts

/**
 * 详情共享状态的异步竞争回归：
 * 普通加载、静默重查、保存/结单回读与 Mutation 直接注入交叉时，
 * 只允许「仍归属当前工单、仍有效、且未被更新事实取代」的读取写共享详情。
 * 走真实 hook 与真实 workbench，只 mock 外部 adapter；全部用可控 Promise，不使用 sleep。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CloseRepairRequestResult,
  EngineerRepairProcessEntry,
  EngineerRepairRequestDetail,
  EngineerRepairRequestDetailResult,
  EngineerRepairRequestResponseItem,
  RepairProcessWriteResult,
} from '../infrastructure/engineer-repair-request.types';
import * as engineerRepairRequestAdapter from '../infrastructure/engineer-repair-request-adapter';

import { useEngineerRepairProcessWorkbench } from './use-engineer-repair-process-workbench';
import { useEngineerRepairRequestDetail } from './use-engineer-repair-request-detail';

vi.mock('../infrastructure/engineer-repair-request-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof engineerRepairRequestAdapter>();

  return {
    ...actual,
    fetchEngineerRepairRequestDetail: vi.fn(),
    createRepairProcessEntry: vi.fn(),
    closeRepairRequest: vi.fn(),
  };
});

const fetchMock = vi.mocked(engineerRepairRequestAdapter.fetchEngineerRepairRequestDetail);
const createMock = vi.mocked(engineerRepairRequestAdapter.createRepairProcessEntry);
const closeMock = vi.mocked(engineerRepairRequestAdapter.closeRepairRequest);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
    handlingStatus: null,
    processEntries: [],
    responses: [],
    ...overrides,
  };
}

function detailOk(detail: EngineerRepairRequestDetail): EngineerRepairRequestDetailResult {
  return { ok: true, detail };
}

const ENTRY: EngineerRepairProcessEntry = {
  id: '101',
  entryUuid: '4f0c5f6a-1111-4111-8111-111111111111',
  requestId: 21,
  operationText: '更换干涉仪镜片',
  testResult: null,
  occurredAt: null,
  timeSource: 'SERVER',
  fileId: null,
  file: null,
  versionNo: 1,
  createdAt: '2026-11-14T03:00:00.000Z',
};

const RESPONSE: EngineerRepairRequestResponseItem = {
  id: 501,
  engineerNickname: '陈工',
  resolutionStatus: 'RESOLVED',
  responseText: '已更换备件',
  createdAt: '2026-11-14T04:00:00.000Z',
};

const PROCESS_OK: RepairProcessWriteResult = { ok: true, entry: ENTRY };

const CLOSE_OK: CloseRepairRequestResult = {
  ok: true,
  closure: {
    requestId: 21,
    closureStatus: 'CLOSED',
    closedAt: '2026-11-14T04:00:00.000Z',
    closureReason: null,
    handlingResult: 'FIXED',
    handlingStatus: 'COMPLETED',
    handlingEndedAt: '2026-11-14T03:30:00.000Z',
  },
};

function useDetailAndWorkbench(id: number) {
  const detail = useEngineerRepairRequestDetail(id);
  const workbench = useEngineerRepairProcessWorkbench(id, detail.reload);

  return { detail, workbench };
}

beforeEach(() => {
  fetchMock.mockReset();
  createMock.mockReset();
  closeMock.mockReset();
});

describe('详情读取的统一提交规则', () => {
  it('普通加载后发的静默读取先成功：结束旧 loading 并保留静默快照', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'INITIAL')));

    const { result } = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const normal = deferred<EngineerRepairRequestDetailResult>();
    const silent = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(normal.promise).mockReturnValueOnce(silent.promise);

    let normalPromise!: Promise<unknown>;
    let silentPromise!: Promise<unknown>;

    act(() => {
      normalPromise = result.current.reload();
    });
    act(() => {
      silentPromise = result.current.recheckSilently();
    });
    expect(result.current.state.status).toBe('loading');

    await act(async () => {
      silent.resolve(detailOk(buildDetail(21, 'SILENT')));
      await silentPromise;
    });
    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: expect.objectContaining({ requestNo: 'SILENT' }),
    });

    await act(async () => {
      normal.resolve(detailOk(buildDetail(21, 'NORMAL')));
      await normalPromise;
    });
    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: expect.objectContaining({ requestNo: 'SILENT' }),
    });
  });

  it('普通加载先成功、静默后成功：后发有效读取覆盖为先', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'INITIAL')));

    const { result } = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const normal = deferred<EngineerRepairRequestDetailResult>();
    const silent = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(normal.promise).mockReturnValueOnce(silent.promise);

    let normalPromise!: Promise<unknown>;
    let silentPromise!: Promise<unknown>;
    act(() => {
      normalPromise = result.current.reload();
    });
    act(() => {
      silentPromise = result.current.recheckSilently();
    });

    await act(async () => {
      normal.resolve(detailOk(buildDetail(21, 'NORMAL')));
      await normalPromise;
    });
    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: expect.objectContaining({ requestNo: 'NORMAL' }),
    });

    await act(async () => {
      silent.resolve(detailOk(buildDetail(21, 'SILENT')));
      await silentPromise;
    });
    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: expect.objectContaining({ requestNo: 'SILENT' }),
    });
  });

  it('静默读取先发出、普通加载后发出：普通视图重置优先，静默不覆盖', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'INITIAL')));

    const { result } = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const silent = deferred<EngineerRepairRequestDetailResult>();
    const normal = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(silent.promise).mockReturnValueOnce(normal.promise);

    let silentPromise!: Promise<unknown>;
    let normalPromise!: Promise<unknown>;
    act(() => {
      silentPromise = result.current.recheckSilently();
    });
    act(() => {
      normalPromise = result.current.reload();
    });

    await act(async () => {
      silent.resolve(detailOk(buildDetail(21, 'SILENT')));
      await silentPromise;
    });
    expect(result.current.state.status).toBe('loading');

    await act(async () => {
      normal.resolve(detailOk(buildDetail(21, 'NORMAL')));
      await normalPromise;
    });
    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: expect.objectContaining({ requestNo: 'NORMAL' }),
    });
  });

  it('后发静默失败时，先发仍有效的静默成功不被连带作废', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'INITIAL')));

    const { result } = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const first = deferred<EngineerRepairRequestDetailResult>();
    const second = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    let firstPromise!: Promise<unknown>;
    let secondPromise!: Promise<unknown>;
    act(() => {
      firstPromise = result.current.reload({ silent: true });
    });
    act(() => {
      secondPromise = result.current.reload({ silent: true });
    });

    await act(async () => {
      second.resolve({ ok: false, reason: 'load-failed', message: '后发失败' });
      await secondPromise;
    });

    await act(async () => {
      first.resolve(detailOk(buildDetail(21, 'FIRST')));
      await firstPromise;
    });

    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: expect.objectContaining({ requestNo: 'FIRST' }),
    });
  });

  it('后发静默失去编辑归属时，先发有效静默结果仍可提交', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'INITIAL')));

    const { result } = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const first = deferred<EngineerRepairRequestDetailResult>();
    const second = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    let applyAllowed = true;
    let firstPromise!: Promise<unknown>;
    let secondPromise!: Promise<unknown>;
    act(() => {
      firstPromise = result.current.reload({ silent: true });
    });
    act(() => {
      secondPromise = result.current.reload({
        silent: true,
        shouldApply: () => applyAllowed,
      });
    });

    applyAllowed = false;
    await act(async () => {
      second.resolve(detailOk(buildDetail(21, 'STALE-INSTANCE')));
      await secondPromise;
    });

    await act(async () => {
      first.resolve(detailOk(buildDetail(21, 'FIRST')));
      await firstPromise;
    });

    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: expect.objectContaining({ requestNo: 'FIRST' }),
    });
  });

  it('普通 loading 中直接注入回复：不丢弃回复，旧普通结果不能覆盖', async () => {
    fetchMock.mockResolvedValueOnce(
      detailOk(buildDetail(21, 'INITIAL', { latestResolutionStatus: 'PENDING' })),
    );

    const { result } = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const normal = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(normal.promise);

    let normalPromise!: Promise<unknown>;
    act(() => {
      normalPromise = result.current.reload();
    });

    act(() => {
      result.current.applyResponse(RESPONSE, 21);
    });
    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: expect.objectContaining({
        responses: [RESPONSE],
        latestResolutionStatus: 'RESOLVED',
      }),
    });

    await act(async () => {
      normal.resolve(detailOk(buildDetail(21, 'OLD-NORMAL')));
      await normalPromise;
    });

    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: expect.objectContaining({
        requestNo: 'INITIAL',
        responses: [RESPONSE],
      }),
    });
  });

  it('普通 loading 中直接注入整份详情：结束 loading 且旧失败不覆盖', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'INITIAL')));

    const { result } = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const normal = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(normal.promise);

    let normalPromise!: Promise<unknown>;
    act(() => {
      normalPromise = result.current.reload();
    });
    expect(result.current.state.status).toBe('loading');

    act(() => {
      result.current.applyDetail(buildDetail(21, 'ACCEPTED'), 21);
    });
    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: expect.objectContaining({ requestNo: 'ACCEPTED' }),
    });

    await act(async () => {
      normal.resolve({ ok: false, reason: 'load-failed', message: '旧加载失败' });
      await normalPromise;
    });

    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: expect.objectContaining({ requestNo: 'ACCEPTED' }),
    });
  });

  it('旧工单的迟到成功与失败都不写新工单', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'INITIAL-21')));

    const { result, rerender } = renderHook(
      ({ id }: { id: number }) => useEngineerRepairRequestDetail(id),
      { initialProps: { id: 21 } },
    );
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const oldSuccess = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(oldSuccess.promise);
    let oldPromise!: Promise<unknown>;
    act(() => {
      oldPromise = result.current.recheckSilently();
    });

    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(22, 'READY-22')));
    rerender({ id: 22 });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        status: 'ready',
        detail: expect.objectContaining({ requestNo: 'READY-22' }),
      }),
    );

    await act(async () => {
      oldSuccess.resolve(detailOk(buildDetail(21, 'LATE-21')));
      await oldPromise;
    });
    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: expect.objectContaining({ requestNo: 'READY-22' }),
    });

    const oldFailure = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(oldFailure.promise);
    act(() => {
      void result.current.reload({ silent: true });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(23, 'READY-23')));
    rerender({ id: 23 });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        status: 'ready',
        detail: expect.objectContaining({ requestNo: 'READY-23' }),
      }),
    );
    await act(async () => {
      oldFailure.resolve({ ok: false, reason: 'load-failed', message: '迟到失败' });
    });
    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: expect.objectContaining({ requestNo: 'READY-23' }),
    });
  });
});

describe('操作后回读与 Mutation 注入交叉', () => {
  it('保存回读在飞时回复成功：补一次回读，最终同时保留过程与回复', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'INITIAL')));
    createMock.mockResolvedValue(PROCESS_OK);

    const { result } = renderHook(() => useDetailAndWorkbench(21));
    await waitFor(() => expect(result.current.detail.state.status).toBe('ready'));

    const readback = deferred<EngineerRepairRequestDetailResult>();
    const retry = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(readback.promise).mockReturnValueOnce(retry.promise);

    let savePromise!: Promise<unknown>;
    act(() => {
      savePromise = result.current.workbench.saveProcess(
        { operationText: '更换干涉仪镜片', testResult: null, occurredAt: null },
        null,
      );
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    act(() => {
      result.current.detail.applyResponse(RESPONSE, 21);
    });

    await act(async () => {
      readback.resolve(
        detailOk(
          buildDetail(21, 'SAVED', {
            processEntries: [ENTRY],
            responses: [],
          }),
        ),
      );
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    await act(async () => {
      retry.resolve(
        detailOk(
          buildDetail(21, 'SAVED-WITH-REPLY', {
            processEntries: [ENTRY],
            responses: [RESPONSE],
            latestResolutionStatus: 'RESOLVED',
          }),
        ),
      );
      await savePromise;
    });

    expect(result.current.detail.state).toMatchObject({
      status: 'ready',
      detail: expect.objectContaining({
        requestNo: 'SAVED-WITH-REPLY',
        processEntries: [ENTRY],
        responses: [RESPONSE],
      }),
    });
    expect(result.current.workbench.saving).toBe(false);
    expect(result.current.workbench.lastProcessResult).toEqual(PROCESS_OK);
  });

  it('结单回读在飞时回复成功：补一次回读，最终同时保留结单与回复', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'INITIAL')));
    closeMock.mockResolvedValue(CLOSE_OK);

    const { result } = renderHook(() => useDetailAndWorkbench(21));
    await waitFor(() => expect(result.current.detail.state.status).toBe('ready'));

    const readback = deferred<EngineerRepairRequestDetailResult>();
    const retry = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(readback.promise).mockReturnValueOnce(retry.promise);

    let closePromise!: Promise<unknown>;
    act(() => {
      closePromise = result.current.workbench.closeRequest('FIXED', null);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    act(() => {
      result.current.detail.applyResponse(RESPONSE, 21);
    });

    await act(async () => {
      readback.resolve(
        detailOk(
          buildDetail(21, 'CLOSED', {
            closureStatus: 'CLOSED',
            handlingResult: 'FIXED',
            handlingStatus: 'COMPLETED',
            responses: [],
          }),
        ),
      );
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    await act(async () => {
      retry.resolve(
        detailOk(
          buildDetail(21, 'CLOSED-WITH-REPLY', {
            closureStatus: 'CLOSED',
            handlingResult: 'FIXED',
            handlingStatus: 'COMPLETED',
            responses: [RESPONSE],
            latestResolutionStatus: 'RESOLVED',
          }),
        ),
      );
      await closePromise;
    });

    expect(result.current.detail.state).toMatchObject({
      status: 'ready',
      detail: expect.objectContaining({
        requestNo: 'CLOSED-WITH-REPLY',
        closureStatus: 'CLOSED',
        responses: [RESPONSE],
      }),
    });
    expect(result.current.workbench.closing).toBe(false);
    expect(result.current.workbench.lastCloseResult).toEqual(CLOSE_OK);
  });

  it('静默读取失败保留当前详情且不伪装成操作失败', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'INITIAL')));

    const { result } = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    fetchMock.mockResolvedValueOnce({ ok: false, reason: 'load-failed', message: '回读失败' });
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.recheckSilently();
    });

    expect(outcome).toEqual({ ok: false, reason: 'load-failed', message: '回读失败' });
    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: expect.objectContaining({ requestNo: 'INITIAL' }),
    });
  });
});
