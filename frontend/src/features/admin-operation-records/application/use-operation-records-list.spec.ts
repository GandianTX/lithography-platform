// src/features/admin-operation-records/application/use-operation-records-list.spec.ts

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OperationRecordItem } from '../infrastructure/admin-operation-records.types';

import { useOperationRecordsList } from './use-operation-records-list';

/**
 * 关键操作记录列表状态机单测（任务 10 S3.2）。
 *
 * 覆盖：初次加载、竞态防护（旧响应一律丢弃）、reloadKey（会话/公司变更）回第 1 页、
 * 失败与重试、enabled=false 不发请求。
 */

type Page = { items: OperationRecordItem[]; total: number; page: number; pageSize: number };

const makeItem = (targetId: string): OperationRecordItem =>
  ({
    eventId: `event-${targetId}`,
    occurredAt: '2026-11-19T10:00:00.000Z',
    actorAdminLevel: 1,
    actorNickname: '管理员',
    organizationId: 2,
    organizationName: '开发联调公司 A',
    operation: 'ADMIN_DELETE_DOCUMENT',
    targetType: 'REFERENCE_DOCUMENT',
    targetId,
    result: 'SUCCEEDED',
    detail: null,
  }) as OperationRecordItem;

describe('useOperationRecordsList', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('初次加载成功并透出 items/total/page', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      items: [makeItem('doc-1')],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    const { result } = renderHook(() => useOperationRecordsList(fetcher, 'session-1'));

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state).toMatchObject({ total: 1, page: 1, pageSize: 10 });
    expect(fetcher).toHaveBeenCalledWith(1, 10);
  });

  it('旧响应一律丢弃：慢的旧分页响应不覆盖新页数据', async () => {
    const resolvers: Array<(value: Page) => void> = [];
    const fetcher = vi.fn(async (page: number): Promise<Page> => {
      if (page === 3) {
        return { items: [makeItem('p3')], total: 30, page: 3, pageSize: 10 };
      }
      return new Promise<Page>((resolve) => {
        resolvers.push(resolve);
      });
    });

    const { result } = renderHook(() => useOperationRecordsList(fetcher, 'session-1'));

    // 初次加载（第 1 页）挂起 → 翻到第 2 页（也挂起）→ 快速跳到第 3 页（立即返回）
    await waitFor(() => expect(fetcher).toHaveBeenNthCalledWith(1, 1, 10));
    await act(async () => {
      result.current.goToPage(2);
    });
    await waitFor(() => expect(fetcher).toHaveBeenNthCalledWith(2, 2, 10));
    await act(async () => {
      result.current.goToPage(3);
    });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    // 第 2 页的迟到响应此刻已是旧响应（requestId 过期），必须被丢弃
    const staleResolver = resolvers[1];
    expect(staleResolver).toBeDefined();
    await act(async () => {
      staleResolver?.({ items: [makeItem('stale')], total: 30, page: 2, pageSize: 10 });
    });

    expect(result.current.state.status).toBe('ready');
    expect(JSON.stringify(result.current.state)).not.toContain('stale');
    expect(result.current.state.status === 'ready' ? result.current.state.page : null).toBe(3);
  });

  it('reloadKey（会话/公司）变化触发回第 1 页重载', async () => {
    const fetcher = vi.fn(
      async (): Promise<Page> => ({
        items: [makeItem('doc-1')],
        total: 1,
        page: 1,
        pageSize: 10,
      }),
    );

    const { result, rerender } = renderHook(
      ({ sessionKey }) => useOperationRecordsList(fetcher, sessionKey),
      {
        initialProps: { sessionKey: 'account-1:org-2' },
      },
    );
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    rerender({ sessionKey: 'account-1:global' });

    await waitFor(() => expect(fetcher).toHaveBeenLastCalledWith(1, 10));
  });

  it('失败进入 failed 态并带用户文案，retry 重放当前页', async () => {
    const fetcher = vi
      .fn<() => Promise<Page>>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 10 });

    const { result } = renderHook(() =>
      useOperationRecordsList(fetcher, 'session-1', {
        failureMessage: '关键操作记录加载失败，请稍后重试。',
      }),
    );

    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(result.current.state.status === 'failed' ? result.current.state.message : null).toBe(
      '关键操作记录加载失败，请稍后重试。',
    );

    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('enabled=false 时不发起请求', async () => {
    const fetcher = vi.fn();
    renderHook(() => useOperationRecordsList(fetcher, 'session-1', { enabled: false }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetcher).not.toHaveBeenCalled();
  });
});
