// src/features/my-records/application/use-my-records-stats.spec.ts

/**
 * 顶部汇总统计单测（任务 07）：
 * - 草稿/已入库总数来自 recordKind 过滤的服务端 total（全量口径，非当页数量）；
 * - 请求按 pageSize=1 + recordKind 下推，不带来源筛选；
 * - 单项失败降级 null（页面显示「—」），不伪造 0；
 * - 过期请求不覆盖新结果。
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MyRecordListPage } from '../infrastructure/my-records.types';
import * as myRecordsAdapter from '../infrastructure/my-records-adapter';

import { useMyRecordsStats } from './use-my-records-stats';

vi.mock('../infrastructure/my-records-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof myRecordsAdapter>();

  return { ...actual, fetchMyRecords: vi.fn() };
});

const fetchMyRecordsMock = vi.mocked(myRecordsAdapter.fetchMyRecords);

function buildPage(total: number): MyRecordListPage {
  return { items: [], total, page: 1, pageSize: 1 };
}

beforeEach(() => {
  fetchMyRecordsMock.mockReset();
});

describe('useMyRecordsStats', () => {
  it('草稿/已入库总数来自 recordKind 过滤的服务端 total（pageSize=1 全量口径）', async () => {
    fetchMyRecordsMock.mockImplementation((query) =>
      Promise.resolve(buildPage(query.filter?.recordKind === 'DRAFT' ? 3 : 12)),
    );

    const { result } = renderHook(() => useMyRecordsStats());

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.draftTotal).toBe(3);
    expect(result.current.formalTotal).toBe(12);
    expect(fetchMyRecordsMock).toHaveBeenCalledWith({
      page: 1,
      pageSize: 1,
      filter: { recordKind: 'DRAFT' },
    });
    expect(fetchMyRecordsMock).toHaveBeenCalledWith({
      page: 1,
      pageSize: 1,
      filter: { recordKind: 'FORMAL' },
    });
  });

  it('单项失败降级 null（显示「—」），不伪造 0', async () => {
    fetchMyRecordsMock.mockImplementation((query) => {
      if (query.filter?.recordKind === 'DRAFT') {
        return Promise.reject(new Error('network'));
      }
      return Promise.resolve(buildPage(12));
    });

    const { result } = renderHook(() => useMyRecordsStats());

    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.draftTotal).toBeNull();
    expect(result.current.formalTotal).toBe(12);
  });

  it('reload 重新拉取，过期请求结果不覆盖新结果', async () => {
    const draftResolvers: Array<(page: MyRecordListPage) => void> = [];
    fetchMyRecordsMock.mockImplementation((query) => {
      if (query.filter?.recordKind === 'FORMAL') {
        return Promise.resolve(buildPage(12));
      }
      return new Promise<MyRecordListPage>((resolve) => {
        draftResolvers.push(resolve);
      });
    });

    const { result } = renderHook(() => useMyRecordsStats());

    // 第一轮 DRAFT 请求挂起期间触发 reload（第二轮）
    await waitFor(() => expect(fetchMyRecordsMock).toHaveBeenCalledTimes(2));
    result.current.reload();
    await waitFor(() => expect(fetchMyRecordsMock).toHaveBeenCalledTimes(4));
    expect(draftResolvers.length).toBe(2);

    // 第二轮正常完成
    draftResolvers[1](buildPage(3));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.draftTotal).toBe(3);

    // 第一轮（已过期）结果最晚到达，不得覆盖
    draftResolvers[0](buildPage(99));
    expect(result.current.draftTotal).toBe(3);
  });
});
