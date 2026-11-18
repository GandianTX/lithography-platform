// src/features/repair-request/application/use-engineer-repair-request-list.spec.ts

/**
 * 工程师列表 query 状态机单测。
 *
 * 走真实 hook 与真实失效通道，只 mock 外部 GraphQL adapter；
 * 不在测试里重写后端分页 / scope / filter 语义。
 *
 * 重点覆盖：
 * - scope 默认 ALL，四态切换回第 1 页且保留筛选；
 * - 设备型号 / 客户昵称组合筛选与清除，筛选变化回第 1 页，翻页沿用筛选；
 * - 请求序号守卫：旧请求晚返回不覆盖新结果；
 * - 失败 / 重试沿用当前光标；失效通道刷新沿用当前光标。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import type {
  EngineerRepairListFilter,
  EngineerRepairRequestListItem,
  EngineerRepairRequestPage,
} from '../infrastructure/engineer-repair-request.types';
import * as engineerRepairRequestAdapter from '../infrastructure/engineer-repair-request-adapter';

import { invalidateEngineerRepairLists } from './engineer-repair-list-refresh';
import { useEngineerRepairRequestList } from './use-engineer-repair-request-list';

vi.mock('../infrastructure/engineer-repair-request-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof engineerRepairRequestAdapter>();

  return {
    ...actual,
    fetchEngineerRepairRequests: vi.fn(),
  };
});

const fetchMock = vi.mocked(engineerRepairRequestAdapter.fetchEngineerRepairRequests);

const NO_FILTER: EngineerRepairListFilter = { equipmentModelId: null, customerNickname: null };
const MODEL_FILTER: EngineerRepairListFilter = { equipmentModelId: 5, customerNickname: null };
const COMBINED_FILTER: EngineerRepairListFilter = { equipmentModelId: 5, customerNickname: '林' };

function buildItem(
  id: number,
  overrides: Partial<EngineerRepairRequestListItem> = {},
): EngineerRepairRequestListItem {
  return {
    id,
    requestNo: `RR20260902100000ABC${id}`,
    equipmentModel: { id: 3, modelCode: 'LITHO-9000', modelName: '光刻机 9000' },
    errorCode: 'E-100',
    createdAt: '2026-09-02T08:00:00.000Z',
    isAccepted: false,
    acceptedAt: null,
    latestResolutionStatus: null,
    customerNickname: '林客户',
    customerCompanyName: null,
    acceptanceViewStatus: 'AVAILABLE',
    acceptedEngineerNickname: null,
    closureStatus: null,
    closedAt: null,
    handlingResult: null,
    handlingStatus: null,
    ...overrides,
  };
}

function buildPage(
  items: EngineerRepairRequestListItem[],
  page = 1,
  pageSize = 10,
): EngineerRepairRequestPage {
  return { items, total: items.length, page, pageSize };
}

function readyItems(state: unknown): number[] {
  return (state as { items: EngineerRepairRequestListItem[] }).items.map((item) => item.id);
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('useEngineerRepairRequestList', () => {
  it('缺省 initialScope 时按 ALL 第 1 页无筛选加载', async () => {
    fetchMock.mockResolvedValue(buildPage([buildItem(21), buildItem(22)]));

    const { result } = renderHook(() => useEngineerRepairRequestList());

    expect(result.current.state.status).toBe('loading');

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith({
      scope: 'ALL',
      filter: NO_FILTER,
      page: 1,
      pageSize: 10,
    });
    expect(result.current.scope).toBe('ALL');
    expect(result.current.filter).toEqual(NO_FILTER);
    expect(result.current.state).toEqual({
      status: 'ready',
      requestSeq: 1,
      cursor: { scope: 'ALL', page: 1, filter: NO_FILTER },
      items: [buildItem(21), buildItem(22)],
      total: 2,
      page: 1,
      pageSize: 10,
    });
  });

  it('initialScope 传入 MINE 时按 MINE 加载（首页「我的接单」入口）', async () => {
    fetchMock.mockResolvedValue(buildPage([buildItem(31)]));

    const { result } = renderHook(() => useEngineerRepairRequestList('MINE'));

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledWith({
      scope: 'MINE',
      filter: NO_FILTER,
      page: 1,
      pageSize: 10,
    });
    expect(result.current.scope).toBe('MINE');
  });

  it('setScope 切换范围回第 1 页并保留已设置的筛选', async () => {
    fetchMock.mockResolvedValue(buildPage([]));

    const { result } = renderHook(() => useEngineerRepairRequestList('ALL'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    await act(async () => {
      result.current.setFilter(COMBINED_FILTER);
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({
        scope: 'ALL',
        filter: COMBINED_FILTER,
        page: 1,
        pageSize: 10,
      }),
    );

    await act(async () => {
      result.current.goToPage(3);
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({
        scope: 'ALL',
        filter: COMBINED_FILTER,
        page: 3,
        pageSize: 10,
      }),
    );

    await act(async () => {
      result.current.setScope('TAKEN_BY_OTHER');
    });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({
        scope: 'TAKEN_BY_OTHER',
        filter: COMBINED_FILTER,
        page: 1,
        pageSize: 10,
      }),
    );
    expect(result.current.scope).toBe('TAKEN_BY_OTHER');
    expect(result.current.filter).toEqual(COMBINED_FILTER);
    expect(result.current.state).toMatchObject({ status: 'ready', page: 1 });
  });

  it('setScope 传入相同范围时不重复请求', async () => {
    fetchMock.mockResolvedValue(buildPage([]));

    const { result } = renderHook(() => useEngineerRepairRequestList('AVAILABLE'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    await act(async () => {
      result.current.setScope('AVAILABLE');
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('setFilter 支持单项与组合筛选，回到第 1 页；清除后恢复无筛选', async () => {
    fetchMock.mockResolvedValue(buildPage([]));

    const { result } = renderHook(() => useEngineerRepairRequestList('ALL'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    // 先翻页，验证筛选变化会把页码拉回第 1 页
    await act(async () => {
      result.current.goToPage(2);
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({
        scope: 'ALL',
        filter: NO_FILTER,
        page: 2,
        pageSize: 10,
      }),
    );

    await act(async () => {
      result.current.setFilter(MODEL_FILTER);
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({
        scope: 'ALL',
        filter: MODEL_FILTER,
        page: 1,
        pageSize: 10,
      }),
    );

    await act(async () => {
      result.current.setFilter(COMBINED_FILTER);
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({
        scope: 'ALL',
        filter: COMBINED_FILTER,
        page: 1,
        pageSize: 10,
      }),
    );
    expect(result.current.filter).toEqual(COMBINED_FILTER);

    await act(async () => {
      result.current.setFilter(NO_FILTER);
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({
        scope: 'ALL',
        filter: NO_FILTER,
        page: 1,
        pageSize: 10,
      }),
    );
    expect(result.current.filter).toEqual(NO_FILTER);
  });

  it('setFilter 传入相同筛选时不重复请求', async () => {
    fetchMock.mockResolvedValue(buildPage([]));

    const { result } = renderHook(() => useEngineerRepairRequestList('ALL'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    await act(async () => {
      result.current.setFilter(MODEL_FILTER);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      result.current.setFilter({ equipmentModelId: 5, customerNickname: null });
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('翻页沿用当前范围与筛选', async () => {
    fetchMock.mockResolvedValue(buildPage([]));

    const { result } = renderHook(() => useEngineerRepairRequestList('MINE'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    await act(async () => {
      result.current.setFilter(MODEL_FILTER);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      result.current.goToPage(4);
    });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({
        scope: 'MINE',
        filter: MODEL_FILTER,
        page: 4,
        pageSize: 10,
      }),
    );
  });

  it('旧请求晚返回时不覆盖新结果', async () => {
    let resolveFirst: (value: EngineerRepairRequestPage) => void = () => {};
    const firstRequest = new Promise<EngineerRepairRequestPage>((resolve) => {
      resolveFirst = resolve;
    });
    fetchMock.mockReturnValueOnce(firstRequest);
    fetchMock.mockResolvedValueOnce(buildPage([buildItem(22)], 2));

    const { result } = renderHook(() => useEngineerRepairRequestList('AVAILABLE'));

    // 第 1 页请求仍在飞时翻到第 2 页
    await act(async () => {
      result.current.goToPage(2);
    });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(readyItems(result.current.state)).toEqual([22]);

    // 过期的第 1 页结果此时才返回：必须被序号守卫丢弃
    await act(async () => {
      resolveFirst(buildPage([buildItem(21)], 1));
      await firstRequest;
    });

    expect(result.current.state).toMatchObject({ status: 'ready', page: 2 });
    expect(readyItems(result.current.state)).toEqual([22]);
  });

  it('切换范围后旧范围响应晚返回不覆盖新范围结果', async () => {
    let resolveAll: (value: EngineerRepairRequestPage) => void = () => {};
    const allRequest = new Promise<EngineerRepairRequestPage>((resolve) => {
      resolveAll = resolve;
    });
    fetchMock.mockReturnValueOnce(allRequest);
    fetchMock.mockResolvedValueOnce(buildPage([buildItem(41)], 1));

    const { result } = renderHook(() => useEngineerRepairRequestList('ALL'));

    // ALL 请求仍在飞时切到 MINE
    await act(async () => {
      result.current.setScope('MINE');
    });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(readyItems(result.current.state)).toEqual([41]);

    // 过期的 ALL 结果此时才返回：必须被序号守卫丢弃
    await act(async () => {
      resolveAll(buildPage([buildItem(21), buildItem(22)], 1));
      await allRequest;
    });

    expect(result.current.scope).toBe('MINE');
    expect(readyItems(result.current.state)).toEqual([41]);
  });

  it('加载失败进入 failed，reload 沿用当前范围与筛选', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    fetchMock.mockRejectedValueOnce(networkError);

    const { result } = renderHook(() => useEngineerRepairRequestList('MINE'));

    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    // 文案直接取共享错误模型的 userMessage，不在本层重写第二套提示
    expect(result.current.state).toMatchObject({
      status: 'failed',
      message: networkError.userMessage,
    });

    await act(async () => {
      result.current.setFilter(MODEL_FILTER);
    });
    await waitFor(() => expect(result.current.state.status).toBe('failed'));

    fetchMock.mockResolvedValueOnce(buildPage([buildItem(31)], 1));
    await act(async () => {
      result.current.reload();
    });

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(fetchMock).toHaveBeenLastCalledWith({
      scope: 'MINE',
      filter: MODEL_FILTER,
      page: 1,
      pageSize: 10,
    });
    expect(readyItems(result.current.state)).toEqual([31]);
  });

  it('auth 失败按共享错误模型文案提示，不在本层伪装成业务结果', async () => {
    const authError = new GraphQLIngressError({ type: 'auth', message: 'token invalid' });
    fetchMock.mockRejectedValueOnce(authError);

    const { result } = renderHook(() => useEngineerRepairRequestList('AVAILABLE'));

    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(result.current.state).toMatchObject({ message: authError.userMessage });
    expect(authError.userMessage).toBe('登录状态已失效，请重新登录后再试。');
  });

  it('接单流程宣告列表失效后按当前范围、筛选与页码刷新', async () => {
    fetchMock.mockResolvedValue(buildPage([buildItem(21)]));

    const { result } = renderHook(() => useEngineerRepairRequestList('MINE'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    await act(async () => {
      result.current.setFilter(MODEL_FILTER);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      result.current.goToPage(2);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    await act(async () => {
      invalidateEngineerRepairLists();
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenLastCalledWith({
      scope: 'MINE',
      filter: MODEL_FILTER,
      page: 2,
      pageSize: 10,
    });
  });

  it('卸载后取消订阅失效通道，不再触发刷新', async () => {
    fetchMock.mockResolvedValue(buildPage([]));

    const { result, unmount } = renderHook(() => useEngineerRepairRequestList('AVAILABLE'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    unmount();

    await act(async () => {
      invalidateEngineerRepairLists();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
