// src/features/repair-request/application/use-engineer-repair-request-detail-flow.race.spec.ts

/**
 * 详情编排的异步竞争回归：
 * - 回复结果不确定时，重查只能更新详情，不能仅凭「出现相同文本」断言本次提交成功；
 * - 工单切换后，旧工单的回复/接单迟到结果不得写详情或反馈到新工单。
 * 走真实 flow/detail hook，只 mock 外部 adapter；全部使用可控 Promise。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AcceptRepairRequestResult,
  CreateEngineerResponseResult,
  EngineerRepairRequestDetail,
  EngineerRepairRequestDetailResult,
  EngineerRepairRequestResponseItem,
} from '../infrastructure/engineer-repair-request.types';
import * as engineerRepairRequestAdapter from '../infrastructure/engineer-repair-request-adapter';

import { useEngineerRepairRequestDetailFlow } from './use-engineer-repair-request-detail-flow';

vi.mock('../infrastructure/engineer-repair-request-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof engineerRepairRequestAdapter>();

  return {
    ...actual,
    fetchEngineerRepairRequestDetail: vi.fn(),
    acceptRepairRequest: vi.fn(),
    createEngineerResponse: vi.fn(),
  };
});

const fetchMock = vi.mocked(engineerRepairRequestAdapter.fetchEngineerRepairRequestDetail);
const acceptMock = vi.mocked(engineerRepairRequestAdapter.acceptRepairRequest);
const createMock = vi.mocked(engineerRepairRequestAdapter.createEngineerResponse);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function buildDetail(id: number, marker: string): EngineerRepairRequestDetail {
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
  };
}

function detailOk(detail: EngineerRepairRequestDetail): EngineerRepairRequestDetailResult {
  return { ok: true, detail };
}

const RESPONSE: EngineerRepairRequestResponseItem = {
  id: 501,
  engineerNickname: '陈工',
  resolutionStatus: 'RESOLVED',
  responseText: '已更换备件',
  createdAt: '2026-11-14T04:00:00.000Z',
};

beforeEach(() => {
  fetchMock.mockReset();
  acceptMock.mockReset();
  createMock.mockReset();
});

describe('回复不确定的收敛边界', () => {
  it('重查出现相同文本的新回复时，仍不判定本次提交成功，保留不确定反馈', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'INITIAL'))).mockResolvedValueOnce(
      detailOk({
        ...buildDetail(21, 'RECHECKED'),
        responses: [RESPONSE],
        latestResolutionStatus: 'RESOLVED',
      }),
    );
    createMock.mockResolvedValue({
      ok: false,
      reason: 'response-failed',
      message: '回复结果不确定',
    } satisfies CreateEngineerResponseResult);

    const { result } = renderHook(() => useEngineerRepairRequestDetailFlow(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let submitResult!: CreateEngineerResponseResult | null;
    await act(async () => {
      submitResult = await result.current.createResponse({
        requestId: 21,
        responseText: RESPONSE.responseText,
        resolutionStatus: 'RESOLVED',
      });
    });

    expect(submitResult).toEqual({
      ok: false,
      reason: 'response-failed',
      message: '回复结果不确定',
    });
    expect(result.current.lastCreateResponseResult).toMatchObject({
      ok: false,
      reason: 'response-failed',
    });
    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: expect.objectContaining({
        requestNo: 'RECHECKED',
        responses: [RESPONSE],
      }),
    });
    expect(result.current.reconciling).toBe(false);
  });

  it('重查期间切工单：旧回复结果不写新详情，也不在新工单显示成功反馈', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'INITIAL')));
    createMock.mockResolvedValue({
      ok: false,
      reason: 'response-failed',
      message: '回复结果不确定',
    } satisfies CreateEngineerResponseResult);

    const { result, rerender } = renderHook(
      ({ id }: { id: number }) => useEngineerRepairRequestDetailFlow(id),
      { initialProps: { id: 21 } },
    );
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const recheck = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockReturnValueOnce(recheck.promise);

    let submitPromise!: Promise<CreateEngineerResponseResult | null>;
    act(() => {
      submitPromise = result.current.createResponse({
        requestId: 21,
        responseText: RESPONSE.responseText,
        resolutionStatus: 'RESOLVED',
      });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(22, 'READY-22')));
    rerender({ id: 22 });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        status: 'ready',
        detail: expect.objectContaining({ requestNo: 'READY-22' }),
      }),
    );

    await act(async () => {
      recheck.resolve(
        detailOk({
          ...buildDetail(21, 'LATE-RECHECK'),
          responses: [RESPONSE],
          latestResolutionStatus: 'RESOLVED',
        }),
      );
      await submitPromise;
    });

    expect(await submitPromise).toMatchObject({ ok: false, reason: 'response-failed' });
    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: expect.objectContaining({ requestNo: 'READY-22', responses: [] }),
    });
    expect(result.current.lastCreateResponseResult).toBeNull();
    expect(result.current.reconciling).toBe(false);
  });
});

describe('接单迟到结果的工单边界', () => {
  it('切工单后旧接单成功不注入新工单，也不显示旧成功反馈', async () => {
    fetchMock.mockResolvedValueOnce(detailOk(buildDetail(21, 'INITIAL')));

    const accept = deferred<AcceptRepairRequestResult>();
    acceptMock.mockReturnValueOnce(accept.promise);

    const { result, rerender } = renderHook(
      ({ id }: { id: number }) => useEngineerRepairRequestDetailFlow(id),
      { initialProps: { id: 21 } },
    );
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let acceptPromise!: Promise<AcceptRepairRequestResult | null>;
    act(() => {
      acceptPromise = result.current.accept();
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
      accept.resolve({ ok: true, detail: buildDetail(21, 'LATE-ACCEPTED') });
      await acceptPromise;
    });

    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: expect.objectContaining({ requestNo: 'READY-22' }),
    });
    expect(result.current.lastAcceptResult).toBeNull();
  });
});
