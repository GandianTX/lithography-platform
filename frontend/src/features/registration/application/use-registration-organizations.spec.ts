// src/features/registration/application/use-registration-organizations.spec.ts
// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('../infrastructure/registration-organization-adapter', () => ({
  fetchRegistrationOrganizations: fetchMock,
}));

import type { RegistrationOrganizationPage } from './registration.types';
import { useRegistrationOrganizations } from './use-registration-organizations';

function pageOf(
  page: number,
  pageSize: number,
  total: number,
  items: RegistrationOrganizationPage['items'],
): RegistrationOrganizationPage {
  return { items, page, pageSize, total };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

describe('useRegistrationOrganizations（公开候选加载）', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('挂载即加载第 1 页并按 total 计算 hasMore', async () => {
    fetchMock.mockResolvedValue(pageOf(1, 20, 25, [{ id: 1, name: '公司A' }]));

    const { result } = renderHook(() => useRegistrationOrganizations());

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledWith({ keyword: undefined, page: 1, pageSize: 20 });
    expect(result.current.state).toMatchObject({
      status: 'ready',
      total: 25,
      hasMore: true,
    });
  });

  it('搜索切换关键字：回到第 1 页并透传去空白关键字', async () => {
    fetchMock.mockResolvedValue(pageOf(1, 20, 1, [{ id: 1, name: '公司A' }]));

    const { result } = renderHook(() => useRegistrationOrganizations());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    act(() => {
      result.current.search('  光刻  ');
    });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({
        keyword: '光刻',
        page: 1,
        pageSize: 20,
      }),
    );
  });

  it('乱序响应：先发后至的旧搜索结果被丢弃', async () => {
    const initial = deferred<RegistrationOrganizationPage>();
    const first = deferred<RegistrationOrganizationPage>();
    const second = deferred<RegistrationOrganizationPage>();

    fetchMock
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useRegistrationOrganizations());
    await act(async () => {
      initial.resolve(pageOf(1, 20, 0, []));
      await initial.promise;
    });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    act(() => {
      result.current.search('A');
    });
    act(() => {
      result.current.search('B');
    });

    // 后发的 B 先返回
    await act(async () => {
      second.resolve(pageOf(1, 20, 1, [{ id: 2, name: '公司B' }]));
      await second.promise;
    });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        status: 'ready',
        items: [{ id: 2, name: '公司B' }],
      }),
    );

    // 先发的 A 迟到，不得覆盖 B
    await act(async () => {
      first.resolve(pageOf(1, 20, 1, [{ id: 1, name: '公司A' }]));
      await first.promise;
    });

    expect(result.current.state).toMatchObject({
      status: 'ready',
      items: [{ id: 2, name: '公司B' }],
    });
  });

  it('加载更多追加下一页并去重；加载完最后一页后 hasMore 为 false', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      name: `公司${index + 1}`,
    }));
    fetchMock
      .mockResolvedValueOnce(pageOf(1, 20, 21, firstPage))
      .mockResolvedValueOnce(pageOf(2, 20, 21, [{ id: 21, name: '公司21' }]));

    const { result } = renderHook(() => useRegistrationOrganizations());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => {
      expect(result.current.state).toMatchObject({ status: 'ready', hasMore: false });
      if (result.current.state.status === 'ready') {
        expect(result.current.state.items).toHaveLength(21);
      }
    });
    expect(fetchMock).toHaveBeenLastCalledWith({ keyword: undefined, page: 2, pageSize: 20 });
  });

  it('首屏失败进入 failed，retry 重新加载当前关键字', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(pageOf(1, 20, 1, [{ id: 1, name: '公司A' }]));

    const { result } = renderHook(() => useRegistrationOrganizations());
    await waitFor(() => expect(result.current.state).toMatchObject({ status: 'failed' }));

    act(() => {
      result.current.retry();
    });

    await waitFor(() => expect(result.current.state).toMatchObject({ status: 'ready' }));
  });

  it('追加失败保留已加载列表并可再次重试', async () => {
    fetchMock
      .mockResolvedValueOnce(pageOf(1, 20, 2, [{ id: 1, name: '公司A' }]))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(pageOf(2, 20, 2, [{ id: 2, name: '公司B' }]));

    const { result } = renderHook(() => useRegistrationOrganizations());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    act(() => {
      result.current.loadMore();
    });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        status: 'ready',
        loadMoreFailed: true,
        items: [{ id: 1, name: '公司A' }],
      }),
    );

    act(() => {
      result.current.loadMore();
    });
    await waitFor(() => {
      if (result.current.state.status === 'ready') {
        expect(result.current.state.items).toEqual([
          { id: 1, name: '公司A' },
          { id: 2, name: '公司B' },
        ]);
      }
    });
  });
});
