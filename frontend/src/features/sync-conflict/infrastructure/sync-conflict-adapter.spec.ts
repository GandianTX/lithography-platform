// src/features/sync-conflict/infrastructure/sync-conflict-adapter.spec.ts

/**
 * 同步冲突 adapter 单测（任务 09 S2.3）。
 *
 * 守住：清单按"只看未处理"下推分页参数；详情与裁决使用服务端给定的入口名与变量；
 * transport 失败不吞（原样上抛由共享错误模型处理）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeGraphQL } from '@/shared/graphql';

import {
  fetchSyncConflictDetail,
  fetchSyncConflicts,
  resolveSyncConflict,
} from './sync-conflict-adapter';

vi.mock('@/shared/graphql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/graphql')>();

  return { ...actual, executeGraphQL: vi.fn() };
});

const executeGraphQLMock = vi.mocked(executeGraphQL);

describe('同步冲突 adapter', () => {
  beforeEach(() => {
    executeGraphQLMock.mockReset();
  });

  it('清单：按未处理过滤与分页参数下推', async () => {
    executeGraphQLMock.mockResolvedValue({
      syncConflicts: {
        items: [],
        total: 0,
        page: 2,
        pageSize: 10,
        truncated: false,
      },
    } as never);

    const result = await fetchSyncConflicts({ statusOnlyPending: true, page: 2, pageSize: 10 });

    expect(result.page).toBe(2);
    expect(result.total).toBe(0);
    const [query, variables] = executeGraphQLMock.mock.calls[0];
    expect(query).toContain('syncConflicts(');
    expect(variables).toEqual({ statusOnlyPending: true, page: 2, pageSize: 10 });
  });

  it('详情：按冲突 ID 取快照与差异', async () => {
    executeGraphQLMock.mockResolvedValue({ syncConflict: { conflictId: 'c-1' } } as never);

    await fetchSyncConflictDetail('c-1');

    const [query, variables] = executeGraphQLMock.mock.calls[0];
    expect(query).toContain('syncConflict(');
    expect(query).toContain('diff {');
    expect(variables).toEqual({ conflictId: 'c-1' });
  });

  it('裁决：动作原样下传，返回 outcome 与冲突摘要', async () => {
    executeGraphQLMock.mockResolvedValue({
      resolveSyncConflict: { outcome: 'later', conflict: { conflictId: 'c-1' } },
    } as never);

    const result = await resolveSyncConflict('c-1', 'LATER', null);

    expect(result.outcome).toBe('later');
    const [query, variables] = executeGraphQLMock.mock.calls[0];
    expect(query).toContain('resolveSyncConflict(');
    expect(variables).toEqual({
      conflictId: 'c-1',
      action: 'LATER',
      displayedCloudVersion: null,
    });
  });

  // R067：客户端必须提交**实际看到**的云端版本，服务端据此复核"云端是否已变化"。
  it('裁决：提交用户实际看到的云端版本', async () => {
    executeGraphQLMock.mockResolvedValue({
      resolveSyncConflict: { outcome: 'resolved', conflict: { conflictId: 'c-1' } },
    } as never);

    await resolveSyncConflict('c-1', 'CLOUD', 5);

    const [, variables] = executeGraphQLMock.mock.calls[0];
    expect(variables).toEqual({
      conflictId: 'c-1',
      action: 'CLOUD',
      displayedCloudVersion: 5,
    });
  });

  it('失败不吞：原样上抛', async () => {
    executeGraphQLMock.mockRejectedValue(new Error('network down'));

    await expect(
      fetchSyncConflicts({ statusOnlyPending: true, page: 1, pageSize: 10 }),
    ).rejects.toThrow('network down');
  });
});
