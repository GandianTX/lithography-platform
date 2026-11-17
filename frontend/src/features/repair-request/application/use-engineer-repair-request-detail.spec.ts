// src/features/repair-request/application/use-engineer-repair-request-detail.spec.ts

/**
 * 工程师详情 query 状态机单测。
 *
 * 走真实 hook，只 mock 外部 GraphQL adapter；
 * 重点覆盖请求序号竞态守卫与 applyDetail（接单 Mutation 返回值原子注入）的生效边界。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import type {
  EngineerRepairRequestDetail,
  EngineerRepairRequestDetailResult,
  EngineerRepairRequestResponseItem,
} from '../infrastructure/engineer-repair-request.types';
import * as engineerRepairRequestAdapter from '../infrastructure/engineer-repair-request-adapter';

import {
  type EngineerRepairRequestDetailLoadOutcome,
  useEngineerRepairRequestDetail,
} from './use-engineer-repair-request-detail';

vi.mock('../infrastructure/engineer-repair-request-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof engineerRepairRequestAdapter>();

  return {
    ...actual,
    fetchEngineerRepairRequestDetail: vi.fn(),
  };
});

const fetchMock = vi.mocked(engineerRepairRequestAdapter.fetchEngineerRepairRequestDetail);
// 统一不可访问文案的唯一真源（adapter 导出），测试不复制第二份
const NOT_ACCESSIBLE_MESSAGE = engineerRepairRequestAdapter.ENGINEER_DETAIL_NOT_ACCESSIBLE_MESSAGE;

function buildDetail(id: number, isAccepted: boolean): EngineerRepairRequestDetail {
  return {
    id,
    requestNo: `RR20260902100000ABC${id}`,
    equipmentModel: { id: 3, modelCode: 'LITHO-9000', modelName: '光刻机 9000' },
    errorCode: 'E-100',
    faultDescription: '设备无法启动',
    contentMd: '# 设备维修申请',
    createdAt: '2026-09-02T08:00:00.000Z',
    isAccepted,
    acceptedAt: isAccepted ? '2026-09-02T08:30:00.000Z' : null,
    latestResolutionStatus: null,
    customerNickname: '林客户',
    customerCompanyName: '林氏精密制造',
    acceptanceViewStatus: isAccepted ? 'MINE' : 'AVAILABLE',
    acceptedEngineerNickname: isAccepted ? '陈工' : null,
    closureStatus: null,
    closedAt: null,
    closureReason: null,
    handlingResult: null,
    handlingStatus: null,
    processEntries: [],
    responses: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('useEngineerRepairRequestDetail', () => {
  it('有效 ID 初次加载进入 ready 并返回映射后的详情', async () => {
    fetchMock.mockResolvedValue({ ok: true, detail: buildDetail(21, false) });

    const { result } = renderHook(() => useEngineerRepairRequestDetail(21));

    expect(result.current.state.status).toBe('loading');

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(21);
    expect(result.current.state).toEqual({
      status: 'ready',
      requestSeq: 1,
      detail: buildDetail(21, false),
    });
  });

  it('ID 为 null 时不发请求，静态落入统一不可访问反馈，reload 为 no-op', async () => {
    const { result } = renderHook(() => useEngineerRepairRequestDetail(null));

    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(fetchMock).not.toHaveBeenCalled();
    // 文案与 adapter 兜底共用单一真源，不在本层复制第二份
    expect(result.current.state).toEqual({
      status: 'failed',
      requestSeq: 1,
      reason: 'not-accessible',
      message: NOT_ACCESSIBLE_MESSAGE,
    });

    await act(async () => {
      result.current.reload();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('有效 ID 请求在飞时切到无效 ID：作废在飞结果并落入统一不可访问反馈', async () => {
    let resolveDetail: (value: EngineerRepairRequestDetailResult) => void = () => {};
    const pending = new Promise<EngineerRepairRequestDetailResult>((resolve) => {
      resolveDetail = resolve;
    });
    fetchMock.mockReturnValueOnce(pending);

    const { result, rerender } = renderHook(
      ({ requestId }: { requestId: number | null }) => useEngineerRepairRequestDetail(requestId),
      // 显式放宽初始 props 类型：后续 rerender 需要切到 null（无效 ID 竞态守卫场景）
      { initialProps: { requestId: 21 as number | null } },
    );
    expect(result.current.state.status).toBe('loading');

    rerender({ requestId: null });
    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(result.current.state).toMatchObject({
      reason: 'not-accessible',
      message: NOT_ACCESSIBLE_MESSAGE,
    });

    // 序号已推进：此前在飞的详情返回不得复活为 ready
    await act(async () => {
      resolveDetail({ ok: true, detail: buildDetail(21, false) });
      await pending;
    });

    expect(result.current.state).toMatchObject({ status: 'failed', reason: 'not-accessible' });
  });

  it.each([
    ['not-accessible', NOT_ACCESSIBLE_MESSAGE],
    ['load-failed', '维修申请详情加载失败，请稍后重试。'],
  ] as const)('业务拒绝 reason=%s 原样落入失败状态', async (reason, message) => {
    fetchMock.mockResolvedValue({ ok: false, reason, message });

    const { result } = renderHook(() => useEngineerRepairRequestDetail(21));

    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(result.current.state).toEqual({
      status: 'failed',
      requestSeq: 1,
      reason,
      message,
    });
  });

  it('transport / auth 失败落入 reason=null 并使用共享错误模型文案', async () => {
    const authError = new GraphQLIngressError({ type: 'auth', message: 'token invalid' });
    fetchMock.mockRejectedValue(authError);

    const { result } = renderHook(() => useEngineerRepairRequestDetail(21));

    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(result.current.state).toMatchObject({ reason: null, message: authError.userMessage });
    expect(authError.userMessage).toBe('登录状态已失效，请重新登录后再试。');
  });

  it('ID 变化时旧请求晚返回不覆盖新详情', async () => {
    let resolveFirst: (value: EngineerRepairRequestDetailResult) => void = () => {};
    const firstRequest = new Promise<EngineerRepairRequestDetailResult>((resolve) => {
      resolveFirst = resolve;
    });
    fetchMock.mockReturnValueOnce(firstRequest);
    fetchMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(22, false) });

    const { result, rerender } = renderHook(
      ({ requestId }: { requestId: number | null }) => useEngineerRepairRequestDetail(requestId),
      { initialProps: { requestId: 21 } },
    );

    rerender({ requestId: 22 });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: buildDetail(22, false),
    });

    await act(async () => {
      resolveFirst({ ok: true, detail: buildDetail(21, false) });
      await firstRequest;
    });

    expect(result.current.state).toMatchObject({ detail: buildDetail(22, false) });
  });

  it('reload 按同一 ID 重新查询并推进序号', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, detail: buildDetail(21, false) })
      .mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });

    const { result } = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    await act(async () => {
      result.current.reload();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(21);
    expect(result.current.state).toEqual({
      status: 'ready',
      requestSeq: 2,
      detail: buildDetail(21, true),
    });
  });

  it('ready 态下 applyDetail 原子注入 Mutation 返回的详情，不发起新查询', async () => {
    fetchMock.mockResolvedValue({ ok: true, detail: buildDetail(21, false) });

    const { result } = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    await act(async () => {
      result.current.applyDetail(buildDetail(21, true));
    });

    expect(result.current.state).toEqual({
      status: 'ready',
      // 序号随当前在飞请求保持，不制造新的在飞请求语义
      requestSeq: 1,
      detail: buildDetail(21, true),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('loading 态下 applyDetail 原子注入并结束 loading，此前发出的旧查询不得覆盖', async () => {
    let resolveDetail: (value: EngineerRepairRequestDetailResult) => void = () => {};
    const pending = new Promise<EngineerRepairRequestDetailResult>((resolve) => {
      resolveDetail = resolve;
    });
    fetchMock.mockReturnValueOnce(pending);

    const { result } = renderHook(() => useEngineerRepairRequestDetail(21));
    expect(result.current.state.status).toBe('loading');

    // 接单 Mutation 返回的是已确认的较新写事实：不能被 loading 吞掉
    await act(async () => {
      result.current.applyDetail(buildDetail(21, true));
    });
    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: buildDetail(21, true),
    });

    // 早于注入发出的读取晚到：旧快照不得覆盖已确认的 Mutation 结果
    await act(async () => {
      resolveDetail({ ok: true, detail: buildDetail(21, false) });
      await pending;
    });

    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: buildDetail(21, true),
    });
  });

  it('failed 态下 applyDetail 被丢弃，不复活为可接单的 ready 状态', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      reason: 'not-accessible',
      message: NOT_ACCESSIBLE_MESSAGE,
    });

    const { result } = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(result.current.state.status).toBe('failed'));

    await act(async () => {
      result.current.applyDetail(buildDetail(21, false));
    });

    expect(result.current.state).toMatchObject({ status: 'failed', reason: 'not-accessible' });
  });
});

describe('useEngineerRepairRequestDetail 的 apply-response（回复原子注入）', () => {
  const BASE = buildDetail(21, true);
  const EXISTING = {
    id: 51,
    engineerNickname: '陈工',
    resolutionStatus: 'PENDING',
    responseText: '已初步处理',
    createdAt: '2026-09-02T09:00:00.000Z',
  } as const;

  async function renderReadyWithExistingResponse() {
    fetchMock.mockResolvedValue({
      ok: true,
      detail: { ...BASE, responses: [EXISTING], latestResolutionStatus: 'PENDING' },
    });
    const rendered = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(rendered.result.current.state.status).toBe('ready'));

    return rendered;
  }

  it('追加新回复并在同一事件内同步 latestResolutionStatus，不发起新查询', async () => {
    const { result, unmount } = await renderReadyWithExistingResponse();

    await act(async () => {
      result.current.applyResponse({
        id: 61,
        engineerNickname: '陈工',
        resolutionStatus: 'RESOLVED',
        responseText: '已修复',
        createdAt: '2026-09-02T10:00:00.000Z',
      });
    });

    expect(result.current.state).toMatchObject({
      status: 'ready',
      // 回复成功注入推进查询版本（1 → 2），使此前在飞的旧查询失效
      requestSeq: 2,
      detail: {
        responses: [
          EXISTING,
          {
            id: 61,
            engineerNickname: '陈工',
            resolutionStatus: 'RESOLVED',
            responseText: '已修复',
            createdAt: '2026-09-02T10:00:00.000Z',
          },
        ],
        latestResolutionStatus: 'RESOLVED',
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('同一回复 ID 不重复追加（重放/重复返回被去重）', async () => {
    const { result, unmount } = await renderReadyWithExistingResponse();

    await act(async () => {
      result.current.applyResponse({ ...EXISTING });
    });

    expect(result.current.state).toMatchObject({
      detail: { responses: [EXISTING], latestResolutionStatus: 'PENDING' },
    });
    unmount();
  });

  it('按 createdAt ASC + id ASC 排序（与后端读取契约同口径）', async () => {
    const { result, unmount } = await renderReadyWithExistingResponse();

    // 服务端 ID 更大但 createdAt 更早（并发窗口内其他工程师刚追加过回复）
    await act(async () => {
      result.current.applyResponse({
        id: 61,
        engineerNickname: '李工',
        resolutionStatus: 'PENDING',
        responseText: '并发回复',
        createdAt: '2026-09-02T08:30:00.000Z',
      });
    });

    const responses =
      result.current.state.status === 'ready' ? result.current.state.detail.responses : [];
    expect(responses.map((item) => [item.id, item.createdAt])).toEqual([
      [61, '2026-09-02T08:30:00.000Z'],
      [51, '2026-09-02T09:00:00.000Z'],
    ]);
    unmount();
  });
});

describe('useEngineerRepairRequestDetail 的 recheckSilently（静默重查）', () => {
  it('成功时不进入 loading，保留 ready 详情并原子更新为最新详情', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, detail: buildDetail(21, false) })
      .mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });

    const { result, unmount } = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.recheckSilently();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 不切 loading：状态始终 ready，序号不随静默重查推进（无在飞请求语义）
    expect(result.current.state).toEqual({
      status: 'ready',
      requestSeq: 1,
      detail: buildDetail(21, true),
    });
    expect(outcome).toEqual({ ok: true, detail: buildDetail(21, true) });
    unmount();
  });

  it('业务拒绝失败时不改动查询状态机，保留当前详情与既有状态', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) })
      .mockResolvedValueOnce({
        ok: false,
        reason: 'not-accessible',
        message: NOT_ACCESSIBLE_MESSAGE,
      });

    const { result, unmount } = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.recheckSilently();
    });

    expect(outcome).toEqual({
      ok: false,
      reason: 'not-accessible',
      message: NOT_ACCESSIBLE_MESSAGE,
    });
    // 详情与 ready 状态保留，失败结果仅交编排层决策
    expect(result.current.state).toEqual({
      status: 'ready',
      requestSeq: 1,
      detail: buildDetail(21, true),
    });
    unmount();
  });

  it('transport 失败转 reason=null 的显式结果，保留当前详情', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    fetchMock
      .mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) })
      .mockRejectedValueOnce(networkError);

    const { result, unmount } = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.recheckSilently();
    });

    expect(outcome).toEqual({ ok: false, reason: null, message: networkError.userMessage });
    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: buildDetail(21, true),
    });
    unmount();
  });

  it('在飞期间再次调用只发出一个请求，重入返回 null', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });
    let resolveRecheck: (value: EngineerRepairRequestDetailResult) => void = () => {};
    const pending = new Promise<EngineerRepairRequestDetailResult>((resolve) => {
      resolveRecheck = resolve;
    });
    fetchMock.mockReturnValueOnce(pending);

    const { result, unmount } = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let first: Promise<EngineerRepairRequestDetailLoadOutcome | null> = Promise.resolve(null);
    let second: Promise<EngineerRepairRequestDetailLoadOutcome | null> = Promise.resolve(null);
    await act(async () => {
      first = result.current.recheckSilently();
      second = result.current.recheckSilently();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(second).resolves.toBeNull();

    await act(async () => {
      resolveRecheck({ ok: true, detail: buildDetail(21, false) });
      await first;
    });

    await expect(first).resolves.toEqual({ ok: true, detail: buildDetail(21, false) });
    unmount();
  });

  it('静默重查开始后序号被其他查询推进时，旧结果不得覆盖新状态', async () => {
    // 初始加载 + 静默重查在飞；随后 reload 推进序号（1 → 2）
    fetchMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });
    let resolveRecheck: (value: EngineerRepairRequestDetailResult) => void = () => {};
    const recheckPending = new Promise<EngineerRepairRequestDetailResult>((resolve) => {
      resolveRecheck = resolve;
    });
    fetchMock.mockReturnValueOnce(recheckPending);
    fetchMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(22, false) });

    const { result, unmount } = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let recheck: Promise<EngineerRepairRequestDetailLoadOutcome | null> = Promise.resolve(null);
    await act(async () => {
      recheck = result.current.recheckSilently();
    });

    // 静默重查在飞期间，用户点「重试」触发 reload：序号推进、状态切 loading
    let reloadOutcome: unknown;
    await act(async () => {
      reloadOutcome = await result.current.reload();
    });
    expect(result.current.state).toMatchObject({
      status: 'ready',
      requestSeq: 2,
      detail: buildDetail(22, false),
    });
    expect(reloadOutcome).toEqual({ ok: true, detail: buildDetail(22, false) });

    // 旧静默重查此时才返回：若实现错误地在完成后读取最新序号，
    // 旧详情会被误贴上序号 2 而覆盖新状态；正确实现按开始时快照序号被守卫丢弃
    await act(async () => {
      resolveRecheck({ ok: true, detail: buildDetail(21, true) });
      await recheck;
    });

    expect(result.current.state).toMatchObject({
      status: 'ready',
      requestSeq: 2,
      detail: buildDetail(22, false),
    });
    unmount();
  });

  it('旧静默查询晚到：apply-response 已推进序号，旧快照被守卫丢弃，不覆盖新回复', async () => {
    const BASE = buildDetail(21, true);
    const EXISTING = {
      id: 51,
      engineerNickname: '陈工',
      resolutionStatus: 'PENDING' as const,
      responseText: '已初步处理',
      createdAt: '2026-09-02T09:00:00.000Z',
    };
    const NEW_RESPONSE = {
      id: 61,
      engineerNickname: '陈工',
      resolutionStatus: 'RESOLVED' as const,
      responseText: '已修复',
      createdAt: '2026-09-02T10:00:00.000Z',
    };
    const staleDetail = {
      ...BASE,
      responses: [EXISTING],
      latestResolutionStatus: 'PENDING' as const,
    };

    // 初始加载：含历史回复，latestResolutionStatus=PENDING
    fetchMock.mockResolvedValueOnce({ ok: true, detail: staleDetail });
    // 旧静默查询在飞，稍后返回「提交前」的旧快照（不含新回复）
    let resolveRecheck: (value: EngineerRepairRequestDetailResult) => void = () => {};
    const recheckPending = new Promise<EngineerRepairRequestDetailResult>((resolve) => {
      resolveRecheck = resolve;
    });
    fetchMock.mockReturnValueOnce(recheckPending);

    const { result, unmount } = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    // 旧静默查询开始（进入时快照当前序号 1）
    let recheck: Promise<EngineerRepairRequestDetailLoadOutcome | null> = Promise.resolve(null);
    await act(async () => {
      recheck = result.current.recheckSilently();
    });

    // 旧查询返回前应用一条成功回复：序号推进到 2，新回复注入，状态推进
    await act(async () => {
      result.current.applyResponse(NEW_RESPONSE);
    });
    expect(result.current.state).toMatchObject({
      status: 'ready',
      requestSeq: 2,
      detail: { responses: [EXISTING, NEW_RESPONSE], latestResolutionStatus: 'RESOLVED' },
    });

    // 旧查询此时才返回提交前旧详情（携带序号 1）：被 reducer 序号守卫丢弃
    await act(async () => {
      resolveRecheck({ ok: true, detail: staleDetail });
      await recheck;
    });

    // 最终仍保留新回复与新 latestResolutionStatus，未被旧快照覆盖或倒退
    expect(result.current.state).toMatchObject({
      status: 'ready',
      requestSeq: 2,
      detail: { responses: [EXISTING, NEW_RESPONSE], latestResolutionStatus: 'RESOLVED' },
    });
    unmount();
  });

  it('requestId 为 null 时静默重查不发请求，直接返回 null', async () => {
    fetchMock.mockReset();
    const { result, unmount } = renderHook(() => useEngineerRepairRequestDetail(null));
    await waitFor(() => expect(result.current.state.status).toBe('failed'));

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.recheckSilently();
    });

    expect(outcome).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    unmount();
  });
});

describe('useEngineerRepairRequestDetail 的统一读取代次（回复重查 vs 写后回读）', () => {
  const INITIAL = { ...buildDetail(21, true), contentMd: '# 初始详情' };
  const FRESH = { ...buildDetail(21, true), contentMd: '# 最新回读' };
  const STALE = { ...buildDetail(21, true), contentMd: '# 旧重查快照' };

  async function renderReady() {
    fetchMock.mockResolvedValueOnce({ ok: true, detail: INITIAL });
    const rendered = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(rendered.result.current.state.status).toBe('ready'));

    return rendered;
  }

  it('回复重查先发、写后回读后发：回读先返回后，旧重查成功晚到不得让详情倒退', async () => {
    const recheckDeferred = deferred<EngineerRepairRequestDetailResult>();
    const readbackDeferred = deferred<EngineerRepairRequestDetailResult>();
    const { result, unmount } = await renderReady();
    fetchMock
      .mockReturnValueOnce(recheckDeferred.promise)
      .mockReturnValueOnce(readbackDeferred.promise);

    let recheck: Promise<EngineerRepairRequestDetailLoadOutcome | null> = Promise.resolve(null);
    let readback: Promise<EngineerRepairRequestDetailLoadOutcome | null> = Promise.resolve(null);
    await act(async () => {
      recheck = result.current.recheckSilently();
      readback = result.current.reload({ silent: true });
    });

    await act(async () => {
      readbackDeferred.resolve({ ok: true, detail: FRESH });
      await readback;
    });
    expect(result.current.state).toMatchObject({ status: 'ready', detail: FRESH });

    await act(async () => {
      recheckDeferred.resolve({ ok: true, detail: STALE });
      await recheck;
    });

    // 旧重查晚到：详情必须仍是后发回读结果
    expect(result.current.state).toMatchObject({ status: 'ready', detail: FRESH });
    unmount();
  });

  it('相反返回顺序：旧重查先返回，后发回读后返回，最终仍为最新请求结果', async () => {
    const recheckDeferred = deferred<EngineerRepairRequestDetailResult>();
    const readbackDeferred = deferred<EngineerRepairRequestDetailResult>();
    const { result, unmount } = await renderReady();
    fetchMock
      .mockReturnValueOnce(recheckDeferred.promise)
      .mockReturnValueOnce(readbackDeferred.promise);

    let recheck: Promise<EngineerRepairRequestDetailLoadOutcome | null> = Promise.resolve(null);
    let readback: Promise<EngineerRepairRequestDetailLoadOutcome | null> = Promise.resolve(null);
    await act(async () => {
      recheck = result.current.recheckSilently();
      readback = result.current.reload({ silent: true });
    });

    await act(async () => {
      recheckDeferred.resolve({ ok: true, detail: STALE });
      await recheck;
    });
    // 后发回读「开始」不使仍有效的先发重查失效：先返回时允许先提交，
    // 随后被后发回读结果取代
    expect(result.current.state).toMatchObject({ status: 'ready', detail: STALE });

    await act(async () => {
      readbackDeferred.resolve({ ok: true, detail: FRESH });
      await readback;
    });

    expect(result.current.state).toMatchObject({ status: 'ready', detail: FRESH });
    unmount();
  });

  it('旧重查先返回、后发的结单/保存回读失败晚到：不得把共享详情改成失败', async () => {
    const recheckDeferred = deferred<EngineerRepairRequestDetailResult>();
    const readbackDeferred = deferred<EngineerRepairRequestDetailResult>();
    const { result, unmount } = await renderReady();
    fetchMock
      .mockReturnValueOnce(recheckDeferred.promise)
      .mockReturnValueOnce(readbackDeferred.promise);

    let recheck: Promise<EngineerRepairRequestDetailLoadOutcome | null> = Promise.resolve(null);
    let readback: Promise<EngineerRepairRequestDetailLoadOutcome | null> = Promise.resolve(null);
    await act(async () => {
      recheck = result.current.recheckSilently();
      readback = result.current.reload({ silent: true });
    });

    await act(async () => {
      recheckDeferred.resolve({ ok: true, detail: FRESH });
      await recheck;
    });
    // 后发回读「开始」不使仍有效的先发重查失效：先返回时允许先提交
    expect(result.current.state).toMatchObject({ status: 'ready', detail: FRESH });

    await act(async () => {
      readbackDeferred.resolve({
        ok: false,
        reason: 'load-failed',
        message: '回读失败-SENTINEL',
      });
      await readback;
    });

    // 最新回读失败：静默请求不写共享失败态，保留当前详情（先发重查结果）
    expect(result.current.state).toMatchObject({ status: 'ready', detail: FRESH });
    unmount();
  });

  it('写后回读先返回、旧重查失败晚到：不回写旧错误且返回该失败结果', async () => {
    const recheckDeferred = deferred<EngineerRepairRequestDetailResult>();
    const readbackDeferred = deferred<EngineerRepairRequestDetailResult>();
    const { result, unmount } = await renderReady();
    fetchMock
      .mockReturnValueOnce(recheckDeferred.promise)
      .mockReturnValueOnce(readbackDeferred.promise);

    let recheck: Promise<EngineerRepairRequestDetailLoadOutcome | null> = Promise.resolve(null);
    let readback: Promise<EngineerRepairRequestDetailLoadOutcome | null> = Promise.resolve(null);
    await act(async () => {
      recheck = result.current.recheckSilently();
      readback = result.current.reload({ silent: true });
    });

    await act(async () => {
      readbackDeferred.resolve({ ok: true, detail: FRESH });
      await readback;
    });

    let recheckOutcome: EngineerRepairRequestDetailLoadOutcome | null = null;
    await act(async () => {
      recheckDeferred.resolve({
        ok: false,
        reason: 'load-failed',
        message: '旧重查失败-SENTINEL',
      });
      recheckOutcome = await recheck;
    });

    expect(recheckOutcome).toEqual({
      ok: false,
      reason: 'load-failed',
      message: '旧重查失败-SENTINEL',
    });
    expect(result.current.state).toMatchObject({ status: 'ready', detail: FRESH });
    unmount();
  });

  it('两条静默读取在飞时切工单：旧工单结果不得写入新工单共享详情', async () => {
    const recheckDeferred = deferred<EngineerRepairRequestDetailResult>();
    const readbackDeferred = deferred<EngineerRepairRequestDetailResult>();
    fetchMock.mockResolvedValueOnce({ ok: true, detail: INITIAL });
    fetchMock
      .mockReturnValueOnce(recheckDeferred.promise)
      .mockReturnValueOnce(readbackDeferred.promise);
    fetchMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(22, false) });

    const { result, rerender, unmount } = renderHook(
      ({ requestId }: { requestId: number }) => useEngineerRepairRequestDetail(requestId),
      { initialProps: { requestId: 21 } },
    );
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let recheck: Promise<EngineerRepairRequestDetailLoadOutcome | null> = Promise.resolve(null);
    let readback: Promise<EngineerRepairRequestDetailLoadOutcome | null> = Promise.resolve(null);
    await act(async () => {
      recheck = result.current.recheckSilently();
      readback = result.current.reload({ silent: true });
    });

    rerender({ requestId: 22 });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        status: 'ready',
        detail: buildDetail(22, false),
      }),
    );

    await act(async () => {
      recheckDeferred.resolve({ ok: true, detail: STALE });
      readbackDeferred.resolve({ ok: true, detail: FRESH });
      await Promise.all([recheck, readback]);
    });

    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: buildDetail(22, false),
    });
    unmount();
  });
});

describe('useEngineerRepairRequestDetail 写后回读的采用信号', () => {
  it('回读结果实际写入共享详情时才通知 onApplied', async () => {
    const initial = { ...buildDetail(21, true), contentMd: '# 初始详情' };
    const readback = { ...initial, contentMd: '# 已被采用的回读' };
    fetchMock.mockResolvedValueOnce({ ok: true, detail: initial });
    const { result, unmount } = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const applied: EngineerRepairRequestDetail[] = [];
    fetchMock.mockResolvedValueOnce({ ok: true, detail: readback });
    await act(async () => {
      await result.current.reload({
        silent: true,
        mutation: true,
        onApplied: (detail) => applied.push(detail),
      });
    });

    expect(applied).toEqual([readback]);
    expect(result.current.state).toMatchObject({ status: 'ready', detail: readback });
    unmount();
  });

  it('回读请求成功但被期间 Mutation 注入取代：不通知 onApplied', async () => {
    const initial = { ...buildDetail(21, true), contentMd: '# 初始详情' };
    const superseded = { ...initial, contentMd: '# 未采用的旧回读' };
    const response: EngineerRepairRequestResponseItem = {
      id: 901,
      engineerNickname: '陈工',
      responseText: '已更换备件',
      resolutionStatus: 'PENDING',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    fetchMock.mockResolvedValueOnce({ ok: true, detail: initial });
    const { result, unmount } = renderHook(() => useEngineerRepairRequestDetail(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const readbackDeferred = deferred<EngineerRepairRequestDetailResult>();
    fetchMock
      .mockReturnValueOnce(readbackDeferred.promise)
      // 被 Mutation 取代后的补读：返回失败，避免再次采用
      .mockResolvedValueOnce({
        ok: false,
        reason: 'load-failed',
        message: '补读失败-SENTINEL',
      });
    const onApplied = vi.fn();

    let readback: Promise<EngineerRepairRequestDetailLoadOutcome | null> = Promise.resolve(null);
    await act(async () => {
      readback = result.current.reload({ silent: true, mutation: true, onApplied });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    act(() => {
      result.current.applyResponse(response, 21);
    });

    await act(async () => {
      readbackDeferred.resolve({ ok: true, detail: superseded });
      await readback;
    });

    expect(onApplied).not.toHaveBeenCalled();
    expect(result.current.state.status).toBe('ready');
    if (result.current.state.status === 'ready') {
      expect(result.current.state.detail.contentMd).toBe('# 初始详情');
      expect(result.current.state.detail.responses).toEqual([response]);
    }
    unmount();
  });
});
