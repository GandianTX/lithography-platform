// src/features/admin-engineer-approval/application/use-admin-engineer-registration-list.spec.ts

/**
 * 审批队列状态机测试：
 * - 状态筛选变化回到第 1 页并重新请求；
 * - 过期响应按请求序号丢弃，不覆盖当前筛选域结果；
 * - 失败保留可重试的显式失败态。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import * as adapter from '../infrastructure/admin-engineer-approval-adapter';

import type { AdminEngineerRegistrationListPage } from './admin-engineer-approval.types';
import { useAdminEngineerRegistrationList } from './use-admin-engineer-registration-list';

vi.mock('../infrastructure/admin-engineer-approval-adapter', () => ({
  fetchAdminEngineerRegistrations: vi.fn(),
}));

const fetchListMock = vi.mocked(adapter.fetchAdminEngineerRegistrations);

const PAGE: AdminEngineerRegistrationListPage = {
  items: [
    {
      applicationId: 61,
      accountId: 501,
      organizationId: 9,
      organizationName: '甲公司',
      status: 'PENDING',
      applicationNote: '希望加入组织',
      submittedAt: '2026-11-01T08:00:00.000Z',
      reviewedAt: null,
      reviewComment: null,
      applicant: {
        nickname: '待审工程师',
        loginName: 'pending-engineer',
        loginEmail: null,
        phone: '13800000001',
        contactEmail: null,
        companyName: null,
      },
    },
  ],
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
  fetchListMock.mockReset();
});

describe('useAdminEngineerRegistrationList', () => {
  it('首屏按默认游标请求队列', async () => {
    fetchListMock.mockResolvedValue(PAGE);

    const { result } = renderHook(() => useAdminEngineerRegistrationList());

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(fetchListMock).toHaveBeenCalledTimes(1);
    expect(fetchListMock.mock.calls[0][0]).toEqual({ page: 1, pageSize: 10, status: null });
  });

  it('翻页与状态筛选都重新下发，筛选回到第 1 页', async () => {
    fetchListMock.mockResolvedValue(PAGE);
    const { result } = renderHook(() => useAdminEngineerRegistrationList());

    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    act(() => {
      result.current.goToPage(3);
    });
    await waitFor(() => expect(fetchListMock).toHaveBeenCalledTimes(2));
    expect(fetchListMock.mock.calls[1][0]).toMatchObject({ page: 3 });

    act(() => {
      result.current.applyFilters({ status: 'REJECTED' });
    });
    await waitFor(() => expect(fetchListMock).toHaveBeenCalledTimes(3));
    expect(fetchListMock.mock.calls[2][0]).toMatchObject({ page: 1, status: 'REJECTED' });
  });

  it('过期响应晚到时不覆盖当前查询域的结果', async () => {
    const first = deferred<AdminEngineerRegistrationListPage>();
    const second = deferred<AdminEngineerRegistrationListPage>();

    fetchListMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useAdminEngineerRegistrationList());

    await waitFor(() => expect(fetchListMock).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.applyFilters({ status: 'APPROVED' });
    });
    await waitFor(() => expect(fetchListMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve({ ...PAGE, total: 2 });
      await second.promise;
    });
    await waitFor(() => expect(result.current.state).toMatchObject({ status: 'ready' }));

    await act(async () => {
      first.resolve(PAGE);
      await first.promise;
    });

    expect(result.current.state).toMatchObject({ status: 'ready', page: { total: 2 } });
  });

  it('ingress 失败进入可重试的失败态并展示共享错误文案', async () => {
    fetchListMock.mockRejectedValue(
      new GraphQLIngressError({ type: 'network', message: 'offline' }),
    );

    const { result } = renderHook(() => useAdminEngineerRegistrationList());

    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(result.current.state).toMatchObject({
      message: '网络连接异常，请稍后重试。',
      status: 'failed',
    });
  });
});
