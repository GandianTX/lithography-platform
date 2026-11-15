// src/features/repair-request/application/use-engineer-repair-request-detail-flow.spec.ts

/**
 * 工程师详情 + 接单编排单测（详情页唯一业务入口）。
 *
 * 走真实编排 hook、真实详情状态机、真实接单 command 与真实列表失效通道，
 * 只 mock 外部 GraphQL adapter。
 *
 * 重点覆盖接单后的刷新取舍：
 * - 成功 → 用 Mutation 返回值原子注入，不重查（无骨架屏闪现）；
 * - 冲突 / not-accessible → 现状已变，重查收敛，不保留可继续接单的过期状态；
 * - accept-failed（接单结果不确定）→ 只重查详情确认，不自动重发接单 Mutation；
 * - 无权限 → 确定拒绝，申请数据未变，不重查，仅提示。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { translate } from '@/shared/i18n';

import type {
  AcceptRepairRequestResult,
  CreateEngineerResponseInput,
  CreateEngineerResponseResult,
  EngineerRepairRequestDetail,
  EngineerRepairRequestDetailResult,
  EngineerRepairRequestResponseItem,
} from '../infrastructure/engineer-repair-request.types';
import * as engineerRepairRequestAdapter from '../infrastructure/engineer-repair-request-adapter';

import { onEngineerRepairListsInvalidated } from './engineer-repair-list-refresh';
import type { EngineerRepairRequestDetailLoadOutcome } from './use-engineer-repair-request-detail';
import { useEngineerRepairRequestDetailFlow } from './use-engineer-repair-request-detail-flow';

vi.mock('../infrastructure/engineer-repair-request-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof engineerRepairRequestAdapter>();

  return {
    ...actual,
    acceptRepairRequest: vi.fn(),
    createEngineerResponse: vi.fn(),
    fetchEngineerRepairRequestDetail: vi.fn(),
  };
});

const acceptMock = vi.mocked(engineerRepairRequestAdapter.acceptRepairRequest);
const createMock = vi.mocked(engineerRepairRequestAdapter.createEngineerResponse);
const fetchDetailMock = vi.mocked(engineerRepairRequestAdapter.fetchEngineerRepairRequestDetail);
const NOT_ACCESSIBLE_MESSAGE = translate(
  'zh-CN',
  engineerRepairRequestAdapter.ENGINEER_DETAIL_NOT_ACCESSIBLE_MESSAGE_KEY,
);

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

const CONFLICT_RESULT: AcceptRepairRequestResult = {
  ok: false,
  reason: 'already-accepted',
  message: '该维修申请已被接单，请刷新后查看最新状态',
};

/** 订阅真实失效通道，验证编排不重复宣告（宣告职责在接单 command 内部） */
function trackListInvalidation() {
  const calls: number[] = [];
  const unsubscribe = onEngineerRepairListsInvalidated(() => {
    calls.push(calls.length + 1);
  });

  return { calls, unsubscribe };
}

async function renderReadyFlow(requestId: number | null = 21) {
  const flow = renderHook(() => useEngineerRepairRequestDetailFlow(requestId));
  await waitFor(() => expect(flow.result.current.state.status).toBe('ready'));

  return flow;
}

beforeEach(() => {
  acceptMock.mockReset();
  createMock.mockReset();
  fetchDetailMock.mockReset();
  fetchDetailMock.mockResolvedValue({ ok: true, detail: buildDetail(21, false) });
});

describe('useEngineerRepairRequestDetailFlow', () => {
  it('挂载即加载详情，未接单时暴露可接单状态', async () => {
    const { result, unmount } = await renderReadyFlow();

    expect(fetchDetailMock).toHaveBeenCalledTimes(1);
    expect(fetchDetailMock).toHaveBeenCalledWith(21);
    expect(result.current.lastAcceptResult).toBeNull();
    expect(result.current.accepting).toBe(false);
    expect(result.current.state).toMatchObject({ detail: buildDetail(21, false) });
    unmount();
  });

  it('接单成功后应用 Mutation 返回的详情，不重新查询', async () => {
    const acceptedDetail = buildDetail(21, true);
    acceptMock.mockResolvedValue({ ok: true, detail: acceptedDetail });
    const { result, unmount } = await renderReadyFlow();

    let acceptResult: AcceptRepairRequestResult | null = null;
    await act(async () => {
      acceptResult = await result.current.accept();
    });

    expect(acceptResult).toEqual({ ok: true, detail: acceptedDetail });
    expect(result.current.state).toMatchObject({ status: 'ready', detail: acceptedDetail });
    // 写后读来自同一 Mutation 返回值：不产生第二次详情查询
    expect(fetchDetailMock).toHaveBeenCalledTimes(1);
    expect(result.current.lastAcceptResult).toEqual({ ok: true, detail: acceptedDetail });
    unmount();
  });

  it('接单成功后宣告列表失效一次（编排不重复宣告）', async () => {
    acceptMock.mockResolvedValue({ ok: true, detail: buildDetail(21, true) });
    const invalidation = trackListInvalidation();
    const { result, unmount } = await renderReadyFlow();

    await act(async () => {
      await result.current.accept();
    });

    expect(invalidation.calls).toHaveLength(1);
    invalidation.unsubscribe();
    unmount();
  });

  it('接单冲突后重查详情并宣告列表失效一次', async () => {
    acceptMock.mockResolvedValue(CONFLICT_RESULT);
    fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, false) });
    fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });
    const invalidation = trackListInvalidation();
    const { result, unmount } = await renderReadyFlow();

    let acceptResult: AcceptRepairRequestResult | null = null;
    await act(async () => {
      acceptResult = await result.current.accept();
    });

    expect(acceptResult).toEqual(CONFLICT_RESULT);
    await waitFor(() => expect(fetchDetailMock).toHaveBeenCalledTimes(2));
    expect(fetchDetailMock).toHaveBeenLastCalledWith(21);
    // 重查后展示最新视角状态（MINE），接单按钮随视角变化消失
    expect(result.current.state).toMatchObject({ status: 'ready', detail: buildDetail(21, true) });
    expect(invalidation.calls).toHaveLength(1);
    invalidation.unsubscribe();
    unmount();
  });

  it('冲突重查进入 not-accessible 时保留冲突提示，且不保留可接单的旧详情', async () => {
    acceptMock.mockResolvedValue(CONFLICT_RESULT);
    fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, false) });
    // 申请被他人接走后当前工程师不再可读：后端统一拒绝且不泄露存在性
    fetchDetailMock.mockResolvedValueOnce({
      ok: false,
      reason: 'not-accessible',
      message: NOT_ACCESSIBLE_MESSAGE,
    });
    const { result, unmount } = await renderReadyFlow();

    await act(async () => {
      await result.current.accept();
    });

    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(result.current.state).toEqual({
      status: 'failed',
      requestSeq: 2,
      reason: 'not-accessible',
      message: NOT_ACCESSIBLE_MESSAGE,
    });
    // 冲突反馈跨重查保留，供 UI 优先于通用不可访问文案展示
    expect(result.current.lastAcceptResult).toEqual(CONFLICT_RESULT);
    unmount();
  });

  it('接单返回 not-accessible（申请已被删除）后同样重查收敛', async () => {
    acceptMock.mockResolvedValue({
      ok: false,
      reason: 'not-accessible',
      message: '维修申请不存在或已删除。',
    });
    fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, false) });
    fetchDetailMock.mockResolvedValueOnce({
      ok: false,
      reason: 'not-accessible',
      message: NOT_ACCESSIBLE_MESSAGE,
    });
    const { result, unmount } = await renderReadyFlow();

    await act(async () => {
      await result.current.accept();
    });

    await waitFor(() => expect(fetchDetailMock).toHaveBeenCalledTimes(2));
    expect(result.current.state).toMatchObject({ status: 'failed', reason: 'not-accessible' });
    unmount();
  });

  it.each([['insufficient-permission', '当前账号无权接单维修申请。']] as const)(
    '接单确定拒绝 reason=%s 不改变申请数据，不错误重查详情',
    async (reason, message) => {
      acceptMock.mockResolvedValue({ ok: false, reason, message });
      const { result, unmount } = await renderReadyFlow();

      let acceptResult: AcceptRepairRequestResult | null = null;
      await act(async () => {
        acceptResult = await result.current.accept();
      });

      expect(acceptResult).toEqual({ ok: false, reason, message });
      expect(fetchDetailMock).toHaveBeenCalledTimes(1);
      // 原详情保持 ready，UI 展示内联错误提示
      expect(result.current.state).toMatchObject({
        status: 'ready',
        detail: buildDetail(21, false),
      });
      unmount();
    },
  );

  describe('accept-failed 接单结果不确定（只重查确认，不自动重发 Mutation）', () => {
    const ACCEPT_FAILED_RESULT: AcceptRepairRequestResult = {
      ok: false,
      reason: 'accept-failed',
      message: '接单失败，请稍后重试。',
    };

    it('触发一次详情重查，重查确认视角为 MINE 时失败反馈收敛为成功', async () => {
      acceptMock.mockResolvedValue(ACCEPT_FAILED_RESULT);
      fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, false) });
      fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });
      const invalidation = trackListInvalidation();
      const { result, unmount } = await renderReadyFlow();

      await act(async () => {
        await result.current.accept();
      });

      await waitFor(() => expect(fetchDetailMock).toHaveBeenCalledTimes(2));
      expect(fetchDetailMock).toHaveBeenLastCalledWith(21);
      // 重查收敛为 MINE 视角，接单按钮随视角变化消失
      expect(result.current.state).toMatchObject({
        status: 'ready',
        detail: buildDetail(21, true),
      });
      // 重查确认视角为 MINE：失败反馈收敛为成功，不再保留矛盾的“接单失败”提示
      expect(result.current.lastAcceptResult).toEqual({ ok: true, detail: buildDetail(21, true) });
      // 结果不确定只重查确认，不自动重发接单 Mutation
      expect(acceptMock).toHaveBeenCalledTimes(1);
      // 列表失效仅由接单 command 宣告一次，编排不重复宣告
      expect(invalidation.calls).toHaveLength(1);
      invalidation.unsubscribe();
      unmount();
    });

    it('重查发现视角为 TAKEN_BY_OTHER 时保留失败反馈，展示真实接单人不做乐观伪造', async () => {
      // 竞争失败：接单被他人完成，Mutation 结果不确定，重查发现视角为 TAKEN_BY_OTHER
      const takenByOtherDetail: EngineerRepairRequestDetail = {
        ...buildDetail(21, true),
        isAccepted: true,
        acceptedAt: '2026-09-02T08:35:00.000Z',
        customerNickname: '林客户',
        customerCompanyName: '林氏精密制造',
        acceptanceViewStatus: 'TAKEN_BY_OTHER',
        acceptedEngineerNickname: '赵工',
      };
      acceptMock.mockResolvedValue(ACCEPT_FAILED_RESULT);
      fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, false) });
      fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: takenByOtherDetail });
      const invalidation = trackListInvalidation();
      const { result, unmount } = await renderReadyFlow();

      await act(async () => {
        await result.current.accept();
      });

      await waitFor(() => expect(fetchDetailMock).toHaveBeenCalledTimes(2));
      // 详情原子更新为重查结果：展示真实接单人（赵工）与接单时间，不伪造“我接单成功”
      expect(result.current.state).toMatchObject({
        status: 'ready',
        detail: takenByOtherDetail,
      });
      // 视角不是 MINE：失败反馈不收敛为成功，保留供 UI 展示
      expect(result.current.lastAcceptResult).toEqual(ACCEPT_FAILED_RESULT);
      // 只重查确认，不自动重发接单 Mutation
      expect(acceptMock).toHaveBeenCalledTimes(1);
      invalidation.unsubscribe();
      unmount();
    });

    it('重查发现仍未接单时保留失败反馈，且可手动重试接单', async () => {
      acceptMock.mockResolvedValue(ACCEPT_FAILED_RESULT);
      fetchDetailMock.mockResolvedValue({ ok: true, detail: buildDetail(21, false) });
      const { result, unmount } = await renderReadyFlow();

      await act(async () => {
        await result.current.accept();
      });

      await waitFor(() => expect(fetchDetailMock).toHaveBeenCalledTimes(2));
      // 重查后仍未接单：详情保持 ready，失败反馈保留供 UI 展示
      expect(result.current.state).toMatchObject({
        status: 'ready',
        detail: buildDetail(21, false),
      });
      expect(result.current.lastAcceptResult).toEqual(ACCEPT_FAILED_RESULT);

      // 不自动重发：至此接单 Mutation 只发送过一次
      expect(acceptMock).toHaveBeenCalledTimes(1);

      // 用户手动重试：ref 锁已释放，可再次发起接单
      acceptMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });
      await act(async () => {
        await result.current.accept();
      });
      expect(acceptMock).toHaveBeenCalledTimes(2);
      expect(result.current.state).toMatchObject({ detail: buildDetail(21, true) });
      unmount();
    });

    it('重查失败时进入既有加载失败/重试状态，失败反馈保留', async () => {
      acceptMock.mockResolvedValue(ACCEPT_FAILED_RESULT);
      fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, false) });
      fetchDetailMock.mockResolvedValueOnce({
        ok: false,
        reason: 'load-failed',
        message: '维修申请详情加载失败，请稍后重试。',
      });
      const { result, unmount } = await renderReadyFlow();

      await act(async () => {
        await result.current.accept();
      });

      await waitFor(() => expect(result.current.state.status).toBe('failed'));
      expect(result.current.state).toMatchObject({
        status: 'failed',
        reason: 'load-failed',
      });
      expect(result.current.lastAcceptResult).toEqual(ACCEPT_FAILED_RESULT);
      // 失败路径同样不产生第二次接单 Mutation
      expect(acceptMock).toHaveBeenCalledTimes(1);
      unmount();
    });
  });

  it('进行中重复调用 accept 返回 null，不产生并行 Mutation 与重复刷新', async () => {
    let resolveAccept: (value: AcceptRepairRequestResult) => void = () => {};
    acceptMock.mockReturnValueOnce(
      new Promise<AcceptRepairRequestResult>((resolve) => {
        resolveAccept = resolve;
      }),
    );
    const { result, unmount } = await renderReadyFlow();

    let first: Promise<AcceptRepairRequestResult | null> = Promise.resolve(null);
    let second: Promise<AcceptRepairRequestResult | null> = Promise.resolve(null);
    await act(async () => {
      first = result.current.accept();
      second = result.current.accept();
    });

    expect(acceptMock).toHaveBeenCalledTimes(1);
    expect(result.current.accepting).toBe(true);

    await act(async () => {
      resolveAccept({ ok: true, detail: buildDetail(21, true) });
      await first;
      await second;
    });

    await expect(second).resolves.toBeNull();
    expect(result.current.accepting).toBe(false);
    expect(fetchDetailMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('requestId 为 null 时 accept 直接拒绝，不发送 Mutation 也不重查', async () => {
    fetchDetailMock.mockReset();
    const { result, unmount } = renderHook(() => useEngineerRepairRequestDetailFlow(null));

    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(fetchDetailMock).not.toHaveBeenCalled();

    let acceptResult: AcceptRepairRequestResult | null = null;
    await act(async () => {
      acceptResult = await result.current.accept();
    });

    expect(acceptResult).toBeNull();
    expect(acceptMock).not.toHaveBeenCalled();

    await act(async () => {
      result.current.reload();
    });
    expect(fetchDetailMock).not.toHaveBeenCalled();
    unmount();
  });

  it('详情首次加载失败后可通过 reload 重试', async () => {
    const networkFailure: EngineerRepairRequestDetailResult = {
      ok: false,
      reason: 'load-failed',
      message: '维修申请详情加载失败，请稍后重试。',
    };
    fetchDetailMock.mockReset();
    fetchDetailMock
      .mockResolvedValueOnce(networkFailure)
      .mockResolvedValueOnce({ ok: true, detail: buildDetail(21, false) });

    const { result, unmount } = renderHook(() => useEngineerRepairRequestDetailFlow(21));
    await waitFor(() => expect(result.current.state.status).toBe('failed'));

    await act(async () => {
      result.current.reload();
    });

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(fetchDetailMock).toHaveBeenCalledTimes(2);
    expect(fetchDetailMock).toHaveBeenLastCalledWith(21);
    unmount();
  });
});

describe('useEngineerRepairRequestDetailFlow 的回复编排', () => {
  const INPUT: CreateEngineerResponseInput = {
    requestId: 21,
    responseText: '已更换备件  ',
    resolutionStatus: 'PENDING',
  };
  const RESPONSE: EngineerRepairRequestResponseItem = {
    id: 61,
    engineerNickname: '陈工',
    resolutionStatus: 'PENDING',
    responseText: '已更换备件',
    createdAt: '2026-09-02T10:00:00.000Z',
  };

  async function renderAcceptedReadyFlow(responses: EngineerRepairRequestResponseItem[] = []) {
    fetchDetailMock.mockResolvedValueOnce({
      ok: true,
      detail: { ...buildDetail(21, true), responses },
    });
    const flow = renderHook(() => useEngineerRepairRequestDetailFlow(21));
    await waitFor(() => expect(flow.result.current.state.status).toBe('ready'));

    return flow;
  }

  it('回复成功后经 apply-response 原子注入详情，不额外查询', async () => {
    createMock.mockResolvedValue({ ok: true, response: RESPONSE });
    const { result, unmount } = await renderAcceptedReadyFlow();

    let submitResult: CreateEngineerResponseResult | null = null;
    await act(async () => {
      submitResult = await result.current.createResponse(INPUT);
    });

    expect(submitResult).toEqual({ ok: true, response: RESPONSE });
    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: {
        responses: [RESPONSE],
        latestResolutionStatus: 'PENDING',
      },
    });
    // 写后读来自同一 Mutation 返回值：不产生第二次详情查询
    expect(fetchDetailMock).toHaveBeenCalledTimes(1);
    expect(result.current.lastCreateResponseResult).toEqual({ ok: true, response: RESPONSE });
    unmount();
  });

  it.each([
    ['not-accepted', '维修申请尚未接单，请先接单后回复'],
    ['not-accessible', '维修申请不存在或不可访问'],
    ['insufficient-permission', '仅工程师账号可以回复维修申请'],
    ['invalid-input', '回复内容无效，请检查后重试。'],
  ] as const)('确定拒绝 reason=%s 不重查详情，保留当前 ready 详情', async (reason, message) => {
    createMock.mockResolvedValue({ ok: false, reason, message });
    const { result, unmount } = await renderAcceptedReadyFlow();

    let submitResult: CreateEngineerResponseResult | null = null;
    await act(async () => {
      submitResult = await result.current.createResponse(INPUT);
    });

    expect(submitResult).toEqual({ ok: false, reason, message });
    expect(result.current.lastCreateResponseResult).toEqual({ ok: false, reason, message });
    expect(fetchDetailMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('response-failed 只静默重查一次：重查更新详情，但相同文本不判定本次提交成功', async () => {
    createMock.mockResolvedValue({
      ok: false,
      reason: 'response-failed',
      message: '处理回复失败，请稍后重试',
    });
    fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });
    // 重查发现服务端有一条正文与状态都相同的新回复（也可能来自并发中的其他提交）
    fetchDetailMock.mockResolvedValueOnce({
      ok: true,
      detail: { ...buildDetail(21, true), responses: [RESPONSE] },
    });
    const { result, unmount } = await renderAcceptedReadyFlow();

    let submitResult: CreateEngineerResponseResult | null = null;
    await act(async () => {
      submitResult = await result.current.createResponse(INPUT);
    });

    // 不能仅凭「回读中有相同文本」断言本次请求确定成功：保留不确定反馈
    expect(submitResult).toEqual({
      ok: false,
      reason: 'response-failed',
      message: '处理回复失败，请稍后重试',
    });
    expect(result.current.lastCreateResponseResult).toEqual({
      ok: false,
      reason: 'response-failed',
      message: '处理回复失败，请稍后重试',
    });
    // 只一次 Mutation + 一次静默重查（不切 loading，详情随重查原子更新）
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(fetchDetailMock).toHaveBeenCalledTimes(2);
    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: { responses: [RESPONSE] },
    });
    expect(result.current.reconciling).toBe(false);
    unmount();
  });

  it('重查详情中没有新 ID（仅旧回复）时不得误判成功，保留不确定结果', async () => {
    const existing = { ...RESPONSE, id: 51 };
    createMock.mockResolvedValue({
      ok: false,
      reason: 'response-failed',
      message: '处理回复失败，请稍后重试',
    });
    fetchDetailMock.mockResolvedValueOnce({
      ok: true,
      detail: { ...buildDetail(21, true), responses: [existing] },
    });
    // 重查详情只有旧 ID，没有新回复
    fetchDetailMock.mockResolvedValueOnce({
      ok: true,
      detail: { ...buildDetail(21, true), responses: [existing] },
    });
    const { result, unmount } = await renderAcceptedReadyFlow([existing]);

    let submitResult: CreateEngineerResponseResult | null = null;
    await act(async () => {
      submitResult = await result.current.createResponse(INPUT);
    });

    expect(submitResult).toEqual({
      ok: false,
      reason: 'response-failed',
      message: '处理回复失败，请稍后重试',
    });
    expect(result.current.lastCreateResponseResult?.ok).toBe(false);
    expect(createMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('重查详情中正文或状态不匹配时不得误判成功，保留不确定结果', async () => {
    createMock.mockResolvedValue({
      ok: false,
      reason: 'response-failed',
      message: '处理回复失败，请稍后重试',
    });
    fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });
    fetchDetailMock.mockResolvedValueOnce({
      ok: true,
      detail: {
        ...buildDetail(21, true),
        // 新 ID 但正文被后端截断/用户改过：不满足「规范化正文 + 相同状态」匹配
        responses: [{ ...RESPONSE, responseText: '已更换其他备件' }],
      },
    });
    const { result, unmount } = await renderAcceptedReadyFlow();

    let submitResult: CreateEngineerResponseResult | null = null;
    await act(async () => {
      submitResult = await result.current.createResponse(INPUT);
    });

    expect(submitResult).toEqual({
      ok: false,
      reason: 'response-failed',
      message: '处理回复失败，请稍后重试',
    });
    expect(result.current.lastCreateResponseResult?.ok).toBe(false);
    unmount();
  });

  it('重查失败时保留不确定结果与当前详情，不重发 Mutation', async () => {
    createMock.mockResolvedValue({
      ok: false,
      reason: 'response-failed',
      message: '处理回复失败，请稍后重试',
    });
    fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });
    fetchDetailMock.mockResolvedValueOnce({
      ok: false,
      reason: 'load-failed',
      message: '维修申请详情加载失败，请稍后重试。',
    });
    const { result, unmount } = await renderAcceptedReadyFlow();

    let submitResult: CreateEngineerResponseResult | null = null;
    await act(async () => {
      submitResult = await result.current.createResponse(INPUT);
    });

    expect(submitResult).toEqual({
      ok: false,
      reason: 'response-failed',
      message: '处理回复失败，请稍后重试',
    });
    // 静默重查失败：详情不切 loading，保持 ready
    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: buildDetail(21, true),
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(fetchDetailMock).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('responseBusyRef 覆盖 Mutation 和收敛重查全过程：收敛期间重复提交不产生第二次 Mutation，完成后锁释放', async () => {
    createMock.mockResolvedValueOnce({
      ok: false,
      reason: 'response-failed',
      message: '处理回复失败，请稍后重试',
    });
    fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });
    // 收敛重查在飞：结果为「无匹配」（旧详情）
    let resolveRecheck: (value: EngineerRepairRequestDetailResult) => void = () => {};
    const recheckPending = new Promise<EngineerRepairRequestDetailResult>((resolve) => {
      resolveRecheck = resolve;
    });
    fetchDetailMock.mockReturnValueOnce(recheckPending);
    const { result, unmount } = await renderAcceptedReadyFlow();

    let first: Promise<CreateEngineerResponseResult | null> = Promise.resolve(null);
    let second: Promise<CreateEngineerResponseResult | null> = Promise.resolve(null);
    await act(async () => {
      first = result.current.createResponse(INPUT);
      second = result.current.createResponse(INPUT);
    });

    // Mutation 已返回，收敛重查仍在飞：提交锁仍被占用
    expect(createMock).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toBeNull();
    expect(result.current.reconciling).toBe(true);

    // 收敛期间重复提交不得产生第二次 Mutation（无幂等键，无重复提交窗口）
    await act(async () => {
      resolveRecheck({ ok: true, detail: buildDetail(21, true) });
      await first;
    });

    await expect(first).resolves.toMatchObject({ ok: false, reason: 'response-failed' });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.current.reconciling).toBe(false);

    // 重查完成后锁释放，用户可正常进行下一次合法提交
    createMock.mockResolvedValueOnce({ ok: true, response: RESPONSE });
    let retry: CreateEngineerResponseResult | null = null;
    await act(async () => {
      retry = await result.current.createResponse(INPUT);
    });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(retry).toEqual({ ok: true, response: RESPONSE });
    unmount();
  });

  it('收敛重查在飞期间（Mutation 已返回）重复提交不得产生第二次 Mutation', async () => {
    createMock.mockResolvedValueOnce({
      ok: false,
      reason: 'response-failed',
      message: '处理回复失败，请稍后重试',
    });
    fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });
    let resolveRecheck: (value: EngineerRepairRequestDetailResult) => void = () => {};
    const recheckPending = new Promise<EngineerRepairRequestDetailResult>((resolve) => {
      resolveRecheck = resolve;
    });
    fetchDetailMock.mockReturnValueOnce(recheckPending);
    const { result, unmount } = await renderAcceptedReadyFlow();

    // 第一次提交：Mutation 已返回 response-failed，编排层停在静默重查 await 上
    let first: Promise<CreateEngineerResponseResult | null> = Promise.resolve(null);
    await act(async () => {
      first = result.current.createResponse(INPUT);
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.current.reconciling).toBe(true);

    // command hook 的提交锁已随 Mutation 返回释放：此时只有编排层锁
    // 能拦住重复提交（无幂等键，不得产生第二条回复）
    let second: Promise<CreateEngineerResponseResult | null> = Promise.resolve(null);
    await act(async () => {
      second = result.current.createResponse(INPUT);
    });
    await expect(second).resolves.toBeNull();
    expect(createMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRecheck({ ok: true, detail: buildDetail(21, true) });
      await first;
    });
    expect(result.current.reconciling).toBe(false);
    unmount();
  });

  it('requestId 与命令不一致时直接拒绝，不发送 Mutation 也不重查', async () => {
    const { result, unmount } = await renderAcceptedReadyFlow();

    let submitResult: CreateEngineerResponseResult | null = null;
    await act(async () => {
      submitResult = await result.current.createResponse({ ...INPUT, requestId: 999 });
    });

    expect(submitResult).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
    expect(fetchDetailMock).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe('useEngineerRepairRequestDetailFlow 的手动确认回复结果（confirmResponseResult）', () => {
  const INPUT: CreateEngineerResponseInput = {
    requestId: 21,
    responseText: '已更换备件',
    resolutionStatus: 'PENDING',
  };
  const RESPONSE: EngineerRepairRequestResponseItem = {
    id: 61,
    engineerNickname: '陈工',
    resolutionStatus: 'PENDING',
    responseText: '已更换备件',
    createdAt: '2026-09-02T10:00:00.000Z',
  };

  it('手动重查挂起期间回复提交返回 null，不产生 Mutation', async () => {
    // 初始加载
    fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });
    // 手动重查在飞（可控 gate，不用固定 sleep）
    let resolveRecheck: (value: EngineerRepairRequestDetailResult) => void = () => {};
    const recheckPending = new Promise<EngineerRepairRequestDetailResult>((resolve) => {
      resolveRecheck = resolve;
    });
    fetchDetailMock.mockReturnValueOnce(recheckPending);

    const { result, unmount } = renderHook(() => useEngineerRepairRequestDetailFlow(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let confirm: Promise<unknown> = Promise.resolve(null);
    await act(async () => {
      confirm = result.current.confirmResponseResult();
    });
    // 手动重查期间 reconciling 置位（与回复提交同一把锁）
    expect(result.current.reconciling).toBe(true);
    expect(fetchDetailMock).toHaveBeenCalledTimes(2);

    // 重查挂起期间再提交回复：被同一把锁拒绝，不产生 Mutation
    let submitResult: CreateEngineerResponseResult | null = null;
    await act(async () => {
      submitResult = await result.current.createResponse(INPUT);
    });
    expect(submitResult).toBeNull();
    expect(createMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveRecheck({ ok: true, detail: buildDetail(21, true) });
      await confirm;
    });
    expect(result.current.reconciling).toBe(false);
    unmount();
  });

  it('手动重查挂起期间再次手动重查只产生一次查询，第二次返回 null', async () => {
    fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });
    let resolveRecheck: (value: EngineerRepairRequestDetailResult) => void = () => {};
    const recheckPending = new Promise<EngineerRepairRequestDetailResult>((resolve) => {
      resolveRecheck = resolve;
    });
    fetchDetailMock.mockReturnValueOnce(recheckPending);

    const { result, unmount } = renderHook(() => useEngineerRepairRequestDetailFlow(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let first: Promise<unknown> = Promise.resolve(null);
    let second: Promise<unknown> = Promise.resolve(null);
    await act(async () => {
      first = result.current.confirmResponseResult();
      second = result.current.confirmResponseResult();
    });

    // 第二次被锁拒绝，不产生第二个详情查询（初始 1 + 手动重查 1）
    await expect(second).resolves.toBeNull();
    expect(fetchDetailMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveRecheck({ ok: true, detail: buildDetail(21, true) });
      await first;
    });
    expect(result.current.reconciling).toBe(false);
    unmount();
  });

  it('手动重查结束后锁释放，允许后续正常提交回复', async () => {
    fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });
    let resolveRecheck: (value: EngineerRepairRequestDetailResult) => void = () => {};
    const recheckPending = new Promise<EngineerRepairRequestDetailResult>((resolve) => {
      resolveRecheck = resolve;
    });
    fetchDetailMock.mockReturnValueOnce(recheckPending);

    const { result, unmount } = renderHook(() => useEngineerRepairRequestDetailFlow(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let confirm: Promise<unknown> = Promise.resolve(null);
    await act(async () => {
      confirm = result.current.confirmResponseResult();
    });
    await act(async () => {
      resolveRecheck({ ok: true, detail: buildDetail(21, true) });
      await confirm;
    });
    expect(result.current.reconciling).toBe(false);

    // 锁已释放：后续提交正常进行，产生一次 Mutation
    createMock.mockResolvedValueOnce({ ok: true, response: RESPONSE });
    let submitResult: CreateEngineerResponseResult | null = null;
    await act(async () => {
      submitResult = await result.current.createResponse(INPUT);
    });
    expect(submitResult).toEqual({ ok: true, response: RESPONSE });
    expect(createMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('手动重查失败时保留当前 ready 详情，释放锁，不自动重发 Mutation', async () => {
    fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });
    let rejectRecheck: (reason?: unknown) => void = () => {};
    const recheckPending = new Promise<EngineerRepairRequestDetailResult>((_resolve, reject) => {
      rejectRecheck = reject;
    });
    fetchDetailMock.mockReturnValueOnce(recheckPending);

    const { result, unmount } = renderHook(() => useEngineerRepairRequestDetailFlow(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let confirm: Promise<unknown> = Promise.resolve(null);
    await act(async () => {
      confirm = result.current.confirmResponseResult();
    });
    expect(result.current.reconciling).toBe(true);

    // 重查以 transport 失败告终（静默重查失败不切状态机）
    await act(async () => {
      rejectRecheck(new Error('network down'));
      await confirm;
    });

    // 当前详情保留，锁与 reconciling 释放，全程未发任何 Mutation
    expect(result.current.state).toMatchObject({ status: 'ready', detail: buildDetail(21, true) });
    expect(result.current.reconciling).toBe(false);
    expect(createMock).not.toHaveBeenCalled();

    // 收敛结束后手动重查入口恢复：可再次发起（此次成功）
    fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });
    await act(async () => {
      await result.current.confirmResponseResult();
    });
    expect(result.current.reconciling).toBe(false);
    expect(createMock).not.toHaveBeenCalled();
    unmount();
  });
});

describe('useEngineerRepairRequestDetailFlow 回复不确定与写后回读交错', () => {
  const INPUT = { requestId: 21, responseText: '已更换备件', resolutionStatus: 'PENDING' as const };
  const RESPONSE: EngineerRepairRequestResponseItem = {
    id: 901,
    engineerNickname: '陈工',
    responseText: INPUT.responseText,
    resolutionStatus: 'PENDING',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const FRESH = {
    ...buildDetail(21, true),
    contentMd: '# 回读含新回复',
    responses: [RESPONSE],
    latestResolutionStatus: 'PENDING' as const,
  };
  const STALE_WITHOUT_RESPONSE = {
    ...buildDetail(21, true),
    contentMd: '# 旧重查无新回复',
    responses: [],
    latestResolutionStatus: null,
  };

  it('回读先返回、旧重查后返回且未匹配新回复：详情保持回读结果，反馈收敛为不确定', async () => {
    createMock.mockResolvedValue({
      ok: false,
      reason: 'response-failed',
      message: '处理回复失败，请稍后重试',
    });
    fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });
    const recheckDeferred = deferred<EngineerRepairRequestDetailResult>();
    const readbackDeferred = deferred<EngineerRepairRequestDetailResult>();
    fetchDetailMock
      .mockReturnValueOnce(recheckDeferred.promise)
      .mockReturnValueOnce(readbackDeferred.promise);

    const { result, unmount } = renderHook(() => useEngineerRepairRequestDetailFlow(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let submit: Promise<CreateEngineerResponseResult | null> = Promise.resolve(null);
    await act(async () => {
      submit = result.current.createResponse(INPUT);
    });
    await waitFor(() => expect(fetchDetailMock).toHaveBeenCalledTimes(2));

    let readback: Promise<EngineerRepairRequestDetailLoadOutcome | null> = Promise.resolve(null);
    await act(async () => {
      readback = result.current.reload({ silent: true });
    });
    await act(async () => {
      readbackDeferred.resolve({ ok: true, detail: FRESH });
      await readback;
    });
    expect(result.current.state).toMatchObject({ status: 'ready', detail: FRESH });
    expect(result.current.reconciling).toBe(true);

    await act(async () => {
      recheckDeferred.resolve({ ok: true, detail: STALE_WITHOUT_RESPONSE });
      await submit;
    });

    // 旧重查快照被丢弃，业务反馈仍为“结果不确定”，不卡在 loading
    expect(result.current.state).toMatchObject({ status: 'ready', detail: FRESH });
    expect(result.current.reconciling).toBe(false);
    expect(result.current.lastCreateResponseResult).toEqual({
      ok: false,
      reason: 'response-failed',
      message: '处理回复失败，请稍后重试',
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('回读先返回、旧重查后返回但出现相同回复：仍保留不确定反馈，详情保持回读结果', async () => {
    createMock.mockResolvedValue({
      ok: false,
      reason: 'response-failed',
      message: '处理回复失败，请稍后重试',
    });
    fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });
    const recheckDeferred = deferred<EngineerRepairRequestDetailResult>();
    const readbackDeferred = deferred<EngineerRepairRequestDetailResult>();
    fetchDetailMock
      .mockReturnValueOnce(recheckDeferred.promise)
      .mockReturnValueOnce(readbackDeferred.promise);

    const { result, unmount } = renderHook(() => useEngineerRepairRequestDetailFlow(21));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let submit: Promise<CreateEngineerResponseResult | null> = Promise.resolve(null);
    await act(async () => {
      submit = result.current.createResponse(INPUT);
    });
    await waitFor(() => expect(fetchDetailMock).toHaveBeenCalledTimes(2));

    let readback: Promise<EngineerRepairRequestDetailLoadOutcome | null> = Promise.resolve(null);
    await act(async () => {
      readback = result.current.reload({ silent: true });
    });
    await act(async () => {
      readbackDeferred.resolve({ ok: true, detail: FRESH });
      await readback;
    });

    const staleMatched = {
      ...buildDetail(21, true),
      contentMd: '# 旧重查匹配但较旧',
      responses: [RESPONSE],
      latestResolutionStatus: 'PENDING' as const,
    };
    let submitResult: CreateEngineerResponseResult | null = null;
    await act(async () => {
      recheckDeferred.resolve({ ok: true, detail: staleMatched });
      submitResult = await submit;
    });

    // 回读中出现相同文本不能证明本次请求确定成功：保留不确定反馈，旧快照不覆盖回读
    expect(submitResult).toEqual({
      ok: false,
      reason: 'response-failed',
      message: '处理回复失败，请稍后重试',
    });
    expect(result.current.lastCreateResponseResult).toEqual({
      ok: false,
      reason: 'response-failed',
      message: '处理回复失败，请稍后重试',
    });
    expect(result.current.state).toMatchObject({ status: 'ready', detail: FRESH });
    expect(result.current.reconciling).toBe(false);
    unmount();
  });

  it('回复不确定重查在飞时切工单：旧结果不写入新工单且 reconciling 正常收敛', async () => {
    createMock.mockResolvedValue({
      ok: false,
      reason: 'response-failed',
      message: '处理回复失败，请稍后重试',
    });
    fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(21, true) });
    const recheckDeferred = deferred<EngineerRepairRequestDetailResult>();
    fetchDetailMock.mockReturnValueOnce(recheckDeferred.promise);
    fetchDetailMock.mockResolvedValueOnce({ ok: true, detail: buildDetail(22, false) });

    const { result, rerender, unmount } = renderHook(
      ({ requestId }: { requestId: number }) => useEngineerRepairRequestDetailFlow(requestId),
      { initialProps: { requestId: 21 } },
    );
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let submit: Promise<CreateEngineerResponseResult | null> = Promise.resolve(null);
    await act(async () => {
      submit = result.current.createResponse(INPUT);
    });
    await waitFor(() => expect(fetchDetailMock).toHaveBeenCalledTimes(2));

    rerender({ requestId: 22 });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        status: 'ready',
        detail: buildDetail(22, false),
      }),
    );

    await act(async () => {
      recheckDeferred.resolve({ ok: true, detail: STALE_WITHOUT_RESPONSE });
      await submit;
    });

    expect(result.current.state).toMatchObject({
      status: 'ready',
      detail: buildDetail(22, false),
    });
    expect(result.current.reconciling).toBe(false);
    expect(result.current.lastCreateResponseResult).not.toMatchObject({ ok: true });
    unmount();
  });
});
