// src/features/admin-company-management/application/use-admin-company-list.spec.ts

/**
 * 公司档案列表状态机测试：
 * - 读入口按模式分流（full → 完整列表 / name-only → 最小名称名单）；
 * - 筛选变化回到第 1 页并重新请求；
 * - 过期响应按请求序号丢弃，不覆盖当前筛选域结果；
 * - 失败保留可重试的显式失败态。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import * as adapter from '../infrastructure/admin-company-adapter';

import type { AdminCompanyListPage } from './admin-company-management.types';
import { useAdminCompanyList } from './use-admin-company-list';

vi.mock('../infrastructure/admin-company-adapter', () => ({
  fetchAdminCompanies: vi.fn(),
  fetchAdminCompanyNames: vi.fn(),
}));

const fetchCompaniesMock = vi.mocked(adapter.fetchAdminCompanies);
const fetchNamesMock = vi.mocked(adapter.fetchAdminCompanyNames);

const FULL_PAGE: AdminCompanyListPage = {
  kind: 'full',
  items: [
    {
      organizationId: 501,
      organizationCode: 'ADMIN_ORG_501',
      name: '甲公司',
      shortName: null,
      contactName: null,
      contactPhone: '13800000001',
      contactEmail: null,
      address: null,
      remark: null,
      isServiceProvider: true,
      isManagedCompany: true,
      kind: 'CLIENT',
      status: 'ACTIVE',
      createdAt: '2026-11-01T08:00:00.000Z',
      updatedAt: '2026-11-01T08:00:00.000Z',
    },
  ],
  page: 1,
  pageSize: 10,
  total: 1,
};

const NAME_PAGE: AdminCompanyListPage = {
  kind: 'name',
  items: [{ id: 7, name: '乙公司' }],
  page: 1,
  pageSize: 10,
  total: 1,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

beforeEach(() => {
  fetchCompaniesMock.mockReset();
  fetchNamesMock.mockReset();
});

describe('useAdminCompanyList', () => {
  it('full 模式请求完整列表，name-only 模式请求最小名称名单', async () => {
    fetchCompaniesMock.mockResolvedValue(FULL_PAGE);
    fetchNamesMock.mockResolvedValue(NAME_PAGE);

    const full = renderHook(() => useAdminCompanyList('full'));

    await waitFor(() => expect(full.result.current.state.status).toBe('ready'));
    expect(fetchCompaniesMock).toHaveBeenCalledTimes(1);
    expect(fetchNamesMock).not.toHaveBeenCalled();
    expect(full.result.current.state).toMatchObject({ page: { kind: 'full' } });

    const names = renderHook(() => useAdminCompanyList('name-only'));

    await waitFor(() => expect(names.result.current.state.status).toBe('ready'));
    expect(fetchNamesMock).toHaveBeenCalledTimes(1);
    expect(names.result.current.state).toMatchObject({ page: { kind: 'name' } });
  });

  it('筛选变化回到第 1 页并按新条件下发', async () => {
    fetchCompaniesMock.mockResolvedValue(FULL_PAGE);
    const { result } = renderHook(() => useAdminCompanyList('full'));

    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    act(() => {
      result.current.goToPage(3);
    });
    await waitFor(() => expect(fetchCompaniesMock).toHaveBeenCalledTimes(2));
    expect(fetchCompaniesMock.mock.calls[1][0]).toMatchObject({ page: 3 });

    act(() => {
      result.current.applyFilters({ keyword: '甲', status: 'DISABLED' });
    });
    await waitFor(() => expect(fetchCompaniesMock).toHaveBeenCalledTimes(3));
    expect(fetchCompaniesMock.mock.calls[2][0]).toMatchObject({
      keyword: '甲',
      page: 1,
      status: 'DISABLED',
    });
  });

  it('过期响应晚到时不覆盖当前查询域的结果', async () => {
    const first = deferred<AdminCompanyListPage>();
    const second = deferred<AdminCompanyListPage>();

    fetchCompaniesMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useAdminCompanyList('full'));

    await waitFor(() => expect(fetchCompaniesMock).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.applyFilters({ keyword: '乙' });
    });
    await waitFor(() => expect(fetchCompaniesMock).toHaveBeenCalledTimes(2));

    // 后发请求先返回：结果生效
    await act(async () => {
      second.resolve({ ...FULL_PAGE, total: 2 });
      await second.promise;
    });
    await waitFor(() => expect(result.current.state).toMatchObject({ status: 'ready' }));

    // 先发请求晚返回：按请求序号丢弃，不得覆盖当前结果
    await act(async () => {
      first.resolve(FULL_PAGE);
      await first.promise;
    });

    expect(result.current.state).toMatchObject({ status: 'ready', page: { total: 2 } });
  });

  it('ingress 失败进入可重试的失败态并展示共享错误文案', async () => {
    fetchCompaniesMock.mockRejectedValue(
      new GraphQLIngressError({ type: 'network', message: 'offline' }),
    );

    const { result } = renderHook(() => useAdminCompanyList('full'));

    await waitFor(() => expect(result.current.state.status).toBe('failed'));

    expect(result.current.state).toMatchObject({
      message: '网络连接异常，请稍后重试。',
      status: 'failed',
    });
  });
});
