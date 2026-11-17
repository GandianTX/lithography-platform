// src/features/repair-request/application/use-accept-repair-request.spec.ts

/**
 * 工程师接单 command 状态单测。
 *
 * 走真实 hook 与真实列表失效通道，只 mock 外部 GraphQL adapter。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import type {
  AcceptRepairRequestResult,
  EngineerRepairRequestDetail,
} from '../infrastructure/engineer-repair-request.types';
import * as engineerRepairRequestAdapter from '../infrastructure/engineer-repair-request-adapter';

import { onEngineerRepairListsInvalidated } from './engineer-repair-list-refresh';
import { useAcceptRepairRequest } from './use-accept-repair-request';

vi.mock('../infrastructure/engineer-repair-request-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof engineerRepairRequestAdapter>();

  return {
    ...actual,
    acceptRepairRequest: vi.fn(),
  };
});

const acceptMock = vi.mocked(engineerRepairRequestAdapter.acceptRepairRequest);

const ACCEPTED_DETAIL: EngineerRepairRequestDetail = {
  id: 21,
  requestNo: 'RR20260902100000ABC123',
  equipmentModel: { id: 3, modelCode: 'LITHO-9000', modelName: '光刻机 9000' },
  errorCode: 'E-100',
  faultDescription: '设备无法启动',
  contentMd: '# 设备维修申请',
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

const CONFLICT_RESULT: AcceptRepairRequestResult = {
  ok: false,
  reason: 'already-accepted',
  message: '该维修申请已被接单，请刷新后查看最新状态',
};

/** 订阅真实失效通道，统计接单流程宣告失效的次数 */
function trackListInvalidation() {
  const calls: number[] = [];
  const unsubscribe = onEngineerRepairListsInvalidated(() => {
    calls.push(calls.length + 1);
  });

  return { calls, unsubscribe };
}

beforeEach(() => {
  acceptMock.mockReset();
});

describe('useAcceptRepairRequest', () => {
  it('接单成功返回后端最新详情并置为最近一次结果', async () => {
    acceptMock.mockResolvedValue({ ok: true, detail: ACCEPTED_DETAIL });

    const { result } = renderHook(() => useAcceptRepairRequest());

    let acceptResult: AcceptRepairRequestResult | null = null;
    await act(async () => {
      acceptResult = await result.current.accept(21);
    });

    expect(acceptMock).toHaveBeenCalledTimes(1);
    expect(acceptMock).toHaveBeenCalledWith(21);
    expect(acceptResult).toEqual({ ok: true, detail: ACCEPTED_DETAIL });
    expect(result.current.result).toEqual({ ok: true, detail: ACCEPTED_DETAIL });
    expect(result.current.accepting).toBe(false);
  });

  it('进行中重复调用只发送一次 Mutation，后到调用返回 null', async () => {
    let resolveAccept: (value: AcceptRepairRequestResult) => void = () => {};
    acceptMock.mockReturnValueOnce(
      new Promise<AcceptRepairRequestResult>((resolve) => {
        resolveAccept = resolve;
      }),
    );

    const { result } = renderHook(() => useAcceptRepairRequest());

    let first: Promise<AcceptRepairRequestResult | null> = Promise.resolve(null);
    let second: Promise<AcceptRepairRequestResult | null> = Promise.resolve(null);
    await act(async () => {
      first = result.current.accept(21);
      second = result.current.accept(21);
    });

    // ref 锁生效：连点不产生并行 Mutation
    expect(acceptMock).toHaveBeenCalledTimes(1);
    expect(result.current.accepting).toBe(true);

    await act(async () => {
      resolveAccept({ ok: true, detail: ACCEPTED_DETAIL });
      await first;
      await second;
    });

    await expect(second).resolves.toBeNull();
    await expect(first).resolves.toEqual({ ok: true, detail: ACCEPTED_DETAIL });
    expect(result.current.accepting).toBe(false);
  });

  it('接单成功后宣告工程师列表失效（仅一次）', async () => {
    acceptMock.mockResolvedValue({ ok: true, detail: ACCEPTED_DETAIL });
    const invalidation = trackListInvalidation();

    const { result } = renderHook(() => useAcceptRepairRequest());
    await act(async () => {
      await result.current.accept(21);
    });

    expect(invalidation.calls).toHaveLength(1);
    invalidation.unsubscribe();
  });

  it('接单冲突后同样宣告列表失效（两个范围的数据都可能已变化）', async () => {
    acceptMock.mockResolvedValue(CONFLICT_RESULT);
    const invalidation = trackListInvalidation();

    const { result } = renderHook(() => useAcceptRepairRequest());

    let acceptResult: AcceptRepairRequestResult | null = null;
    await act(async () => {
      acceptResult = await result.current.accept(21);
    });

    expect(acceptResult).toEqual(CONFLICT_RESULT);
    expect(invalidation.calls).toHaveLength(1);
    invalidation.unsubscribe();
  });

  it.each([
    ['not-accessible', '维修申请不存在或已删除。'],
    ['insufficient-permission', '当前账号无权接单维修申请。'],
  ] as const)('接单确定拒绝 reason=%s 不改变列表数据，不宣告失效', async (reason, message) => {
    acceptMock.mockResolvedValue({ ok: false, reason, message });
    const invalidation = trackListInvalidation();

    const { result } = renderHook(() => useAcceptRepairRequest());
    await act(async () => {
      await result.current.accept(21);
    });

    expect(invalidation.calls).toHaveLength(0);
    expect(result.current.result).toEqual({ ok: false, reason, message });
    invalidation.unsubscribe();
  });

  it('accept-failed（接单结果不确定）同样宣告列表失效（仅一次）', async () => {
    acceptMock.mockResolvedValue({
      ok: false,
      reason: 'accept-failed',
      message: '接单失败，请稍后重试。',
    });
    const invalidation = trackListInvalidation();

    const { result } = renderHook(() => useAcceptRepairRequest());
    await act(async () => {
      await result.current.accept(21);
    });

    expect(invalidation.calls).toHaveLength(1);
    invalidation.unsubscribe();
  });

  it('auth 失败沿用共享错误模型文案，不在本层伪装成业务拒绝原因', async () => {
    const authError = new GraphQLIngressError({ type: 'auth', message: 'token invalid' });
    acceptMock.mockRejectedValue(authError);
    const invalidation = trackListInvalidation();

    const { result } = renderHook(() => useAcceptRepairRequest());

    let acceptResult: AcceptRepairRequestResult | null = null;
    await act(async () => {
      acceptResult = await result.current.accept(21);
    });

    // 共享链路已完成 Session 失效宣告，本层只把 transport 失败转为提示，
    // 不得误判为 insufficient-permission / already-accepted；
    // transport 失败统一视为接单结果不确定（accept-failed），列表一并宣告失效
    expect(acceptResult).toEqual({
      ok: false,
      reason: 'accept-failed',
      message: authError.userMessage,
    });
    expect(authError.userMessage).toBe('登录状态已失效，请重新登录后再试。');
    expect(invalidation.calls).toHaveLength(1);
    expect(result.current.accepting).toBe(false);
    invalidation.unsubscribe();
  });

  it('网络失败转为共享文案并释放进行中状态，可再次接单', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    acceptMock.mockRejectedValueOnce(networkError);

    const { result } = renderHook(() => useAcceptRepairRequest());
    await act(async () => {
      await result.current.accept(21);
    });

    await waitFor(() =>
      expect(result.current.result).toEqual({
        ok: false,
        reason: 'accept-failed',
        message: networkError.userMessage,
      }),
    );

    // 失败后 ref 锁必须已释放，否则用户无法重试
    acceptMock.mockResolvedValueOnce({ ok: true, detail: ACCEPTED_DETAIL });
    await act(async () => {
      await result.current.accept(21);
    });
    expect(acceptMock).toHaveBeenCalledTimes(2);
    expect(result.current.result).toEqual({ ok: true, detail: ACCEPTED_DETAIL });
  });

  it('convergeToAccepted 把最近一次结果改写为成功（accept-failed 重查确认后的收敛入口）', async () => {
    acceptMock.mockResolvedValue({
      ok: false,
      reason: 'accept-failed',
      message: '接单失败，请稍后重试。',
    });

    const { result } = renderHook(() => useAcceptRepairRequest());
    await act(async () => {
      await result.current.accept(21);
    });
    expect(result.current.result).toMatchObject({ ok: false, reason: 'accept-failed' });

    await act(async () => {
      result.current.convergeToAccepted(ACCEPTED_DETAIL);
    });
    expect(result.current.result).toEqual({ ok: true, detail: ACCEPTED_DETAIL });
  });
});
