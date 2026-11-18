// src/features/account-settings/application/use-managed-company-search.spec.ts
// @vitest-environment jsdom

/**
 * 受管公司候选检索 hook 单测。
 *
 * 只 mock infrastructure adapter，覆盖：启用即检索第一页（空关键字）、关键字变化发起
 * 新请求、请求序号防乱序（迟到响应丢弃）、未启用不发请求且切回时清空状态、
 * 失败收敛与用当前关键字重试。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import * as accountSettingsAdapter from '../infrastructure/account-settings-adapter';

import type { ManagedCompanyPage } from './account-settings.types';
import { MANAGED_COMPANY_PAGE_SIZE, useManagedCompanySearch } from './use-managed-company-search';

vi.mock('../infrastructure/account-settings-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof accountSettingsAdapter>();

  return { ...actual, searchManagedCompanies: vi.fn() };
});

const searchMock = vi.mocked(accountSettingsAdapter.searchManagedCompanies);

function makePage(items: Array<{ id: number; name: string }>): ManagedCompanyPage {
  return { items, page: 1, pageSize: MANAGED_COMPANY_PAGE_SIZE, total: items.length };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

beforeEach(() => {
  searchMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useManagedCompanySearch', () => {
  it('启用即检索第一页（空关键字），ready 暴露候选与总数', async () => {
    searchMock.mockResolvedValue(makePage([{ id: 1, name: '受管公司甲' }]));
    const { result } = renderHook(() => useManagedCompanySearch(true));

    await waitFor(() =>
      expect(result.current.state).toEqual({
        options: [{ id: 1, name: '受管公司甲' }],
        status: 'ready',
        total: 1,
      }),
    );
    expect(searchMock).toHaveBeenCalledWith({
      keyword: '',
      page: 1,
      pageSize: MANAGED_COMPANY_PAGE_SIZE,
    });
    expect(result.current.keyword).toBe('');
  });

  it('关键字变化发起新检索，并以最新请求的响应为准（迟到响应被丢弃）', async () => {
    const initial = deferred<ManagedCompanyPage>();
    const second = deferred<ManagedCompanyPage>();
    searchMock.mockReturnValueOnce(initial.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useManagedCompanySearch(true));

    // 启用后的首轮检索在微任务中发起：先等它真实发出，再模拟用户输入，
    // 使「初始请求 → 关键字请求」的先后关系稳定（与实现的首发时序一致）
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.setKeyword('乙');
    });

    await act(async () => {
      second.resolve(makePage([{ id: 2, name: '受管公司乙' }]));
      await second.promise;
    });

    await waitFor(() =>
      expect(result.current.state).toEqual({
        options: [{ id: 2, name: '受管公司乙' }],
        status: 'ready',
        total: 1,
      }),
    );

    // 首个请求（空关键字）晚到：序号已推进，不得覆盖最新结果
    await act(async () => {
      initial.resolve(makePage([{ id: 1, name: '受管公司甲' }]));
      await initial.promise;
    });

    expect(result.current.state).toEqual({
      options: [{ id: 2, name: '受管公司乙' }],
      status: 'ready',
      total: 1,
    });
    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(result.current.keyword).toBe('乙');
  });

  it('未启用时不发请求且保持 idle；从启用切到禁用时清空关键字与候选', async () => {
    searchMock.mockResolvedValue(makePage([{ id: 1, name: '受管公司甲' }]));
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useManagedCompanySearch(enabled),
      { initialProps: { enabled: false } },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(searchMock).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ status: 'idle' });

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    rerender({ enabled: false });
    await waitFor(() => expect(result.current.state).toEqual({ status: 'idle' }));
    expect(result.current.keyword).toBe('');
  });

  it('失败收敛为 failed 与兜底文案；retry 用当前关键字重试', async () => {
    searchMock
      .mockRejectedValueOnce(new GraphQLIngressError({ message: 'down', type: 'network' }))
      .mockResolvedValueOnce(makePage([{ id: 3, name: '受管公司丙' }]));
    const { result } = renderHook(() => useManagedCompanySearch(true));

    await waitFor(() =>
      expect(result.current.state).toEqual({
        message: '网络连接异常，请稍后重试。',
        status: 'failed',
      }),
    );

    act(() => {
      result.current.retry();
    });

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(searchMock).toHaveBeenLastCalledWith({
      keyword: '',
      page: 1,
      pageSize: MANAGED_COMPANY_PAGE_SIZE,
    });
  });

  it('未分类错误同样收敛为 failed，原始错误保留在控制台', async () => {
    const boom = new Error('unexpected');
    searchMock.mockRejectedValue(boom);
    const { result } = renderHook(() => useManagedCompanySearch(true));

    await waitFor(() =>
      expect(result.current.state).toEqual({
        message: '公司候选加载失败，请稍后重试。',
        status: 'failed',
      }),
    );
    expect(console.error).toHaveBeenCalledWith(expect.any(String), boom);
  });
});
