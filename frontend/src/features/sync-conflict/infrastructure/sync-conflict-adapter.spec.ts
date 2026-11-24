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

/**
 * 与 GraphQL 选择集一致的**完整**响应夹具。
 *
 * 之前这些用例只给了 `{ conflictId: 'c-1' }` 这样的**残缺**夹具，
 * 形状校验（任务 09 第 11 项补齐）会把它判为非法响应——这正是校验的目的：
 * 真实服务端必定返回选择集里的全部字段，残缺夹具只存在于测试里。
 */
const SUMMARY_FIXTURE = {
  conflictId: 'c-1',
  recordUuid: 'uuid-c-1',
  resourceType: 'REFERENCE_DOCUMENT',
  versionNo: 2,
  localVersion: 1,
  cloudVersion: 2,
  displayedCloudVersion: 2,
  decision: null,
  status: 'PENDING',
  conflictReason: '云端版本较新',
  createdAt: '2026-11-23T08:00:00.000Z',
} as const;

const DETAIL_FIXTURE = {
  ...SUMMARY_FIXTURE,
  organizationId: 9,
  localSnapshot: '本地版本正文',
  cloudSnapshot: '云端版本正文',
  diff: {
    entries: [{ path: 'title', kind: 'CHANGED', localValue: 'A', cloudValue: 'B' }],
    truncated: false,
    invalid: false,
  },
  sourceRecordId: 12,
  sourceReadOnly: false,
  sourceReadOnlyReason: null,
  canAdoptCloud: true,
  adoptionReadOnly: false,
  confirmedByAccountId: null,
  confirmedAt: null,
} as const;

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
    executeGraphQLMock.mockResolvedValue({ syncConflict: DETAIL_FIXTURE } as never);

    await fetchSyncConflictDetail('c-1');

    const [query, variables] = executeGraphQLMock.mock.calls[0];
    expect(query).toContain('syncConflict(');
    expect(query).toContain('diff {');
    expect(variables).toEqual({ conflictId: 'c-1' });
  });

  it('裁决：动作原样下传，返回 outcome 与冲突摘要', async () => {
    executeGraphQLMock.mockResolvedValue({
      resolveSyncConflict: { outcome: 'later', conflict: SUMMARY_FIXTURE },
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
      resolveSyncConflict: { outcome: 'resolved', conflict: SUMMARY_FIXTURE },
    } as never);

    await resolveSyncConflict('c-1', 'CLOUD', 5);

    const [, variables] = executeGraphQLMock.mock.calls[0];
    expect(variables).toEqual({
      conflictId: 'c-1',
      action: 'CLOUD',
      displayedCloudVersion: 5,
    });
  });

  // 形状校验（任务 09 第 11 项补齐）：失败关闭，避免错形状值进入渲染层
  it('形状校验：详情快照正文不是字符串时失败关闭（不把错形状交给渲染层）', async () => {
    executeGraphQLMock.mockResolvedValue({
      syncConflict: { ...DETAIL_FIXTURE, localSnapshot: { title: '对象而非字符串' } },
    } as never);

    await expect(fetchSyncConflictDetail('c-1')).rejects.toThrow('localSnapshot');
  });

  it('形状校验：详情缺少 diff 时失败关闭', async () => {
    const { diff: _diff, ...withoutDiff } = DETAIL_FIXTURE;
    executeGraphQLMock.mockResolvedValue({ syncConflict: withoutDiff } as never);

    await expect(fetchSyncConflictDetail('c-1')).rejects.toThrow('diff');
  });

  it('形状校验：diff 显式为 null 是合法响应（GraphQL 契约里 diff 可空）', async () => {
    executeGraphQLMock.mockResolvedValue({
      syncConflict: { ...DETAIL_FIXTURE, diff: null },
    } as never);

    const result = await fetchSyncConflictDetail('c-1');

    expect(result.diff).toBeNull();
  });

  it('形状校验：清单项缺少必填字段时失败关闭', async () => {
    executeGraphQLMock.mockResolvedValue({
      syncConflicts: {
        items: [{ conflictId: 'c-1' }],
        total: 1,
        page: 1,
        pageSize: 10,
        truncated: false,
      },
    } as never);

    await expect(
      fetchSyncConflicts({ statusOnlyPending: true, page: 1, pageSize: 10 }),
    ).rejects.toThrow('recordUuid');
  });

  it('形状校验：裁决结果缺少 outcome 时失败关闭', async () => {
    executeGraphQLMock.mockResolvedValue({
      resolveSyncConflict: { conflict: SUMMARY_FIXTURE },
    } as never);

    await expect(resolveSyncConflict('c-1', 'LATER', null)).rejects.toThrow('outcome');
  });

  it('失败不吞：原样上抛', async () => {
    executeGraphQLMock.mockRejectedValue(new Error('network down'));

    await expect(
      fetchSyncConflicts({ statusOnlyPending: true, page: 1, pageSize: 10 }),
    ).rejects.toThrow('network down');
  });
});
