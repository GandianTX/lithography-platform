// src/adapters/api/graphql/local-runtime/sync-conflict.resolver.spec.ts
//
// 同步冲突裁决入口的**动作分派**单测（任务 09 R-03）。
//
// 覆盖口径：
// - 「保留本地」按动作分派到管理员文档库域的受控修订入口（不落到本地运行域用例）；
// - 「使用云端」「稍后处理」分派到本地运行域用例；
// - 裁决返回体只映射**冲突摘要**，不带本地/云端两份正文快照。
//
// 守卫（JwtAuthGuard／RolesGuard）与会话失效信号（UNAUTHENTICATED）属框架层共享能力，
// 由仓库既有适配器与异常过滤器用例覆盖；本文件只锁本入口自己的分派与映射。

import { IdentityTypeEnum } from '@app-types/models/account.types';
import type { AuthenticatedSessionUser } from '@app-types/auth/session-restriction.types';

import { SyncConflictResolver } from './sync-conflict.resolver';

describe('SyncConflictResolver · 动作分派与返回映射', () => {
  const user = {
    id: 900101,
    accountId: 900101,
    username: 'admin',
    roles: [IdentityTypeEnum.SUPER_ADMIN],
    activeRole: IdentityTypeEnum.SUPER_ADMIN,
    adminLevel: 1,
    organizationId: null,
  } as unknown as AuthenticatedSessionUser;

  const summary = {
    conflictId: 'c-1',
    recordUuid: 'record-uuid-1',
    organizationId: 4,
    resourceType: 'REPAIR_REQUEST',
    versionNo: 3,
    localVersion: 4,
    cloudVersion: 5,
    displayedCloudVersion: 5,
    decision: null,
    status: 'PENDING',
    conflictReason: 'both sides changed',
    confirmedByAccountId: null,
    confirmedAt: null,
    createdAt: new Date('2026-11-19T00:00:00.000Z'),
  };

  const build = () => {
    const listSyncConflictsUsecase = { execute: jest.fn() };
    const getSyncConflictUsecase = { execute: jest.fn() };
    const resolveSyncConflictUsecase = {
      execute: jest.fn(() => Promise.resolve({ outcome: 'resolved', conflict: summary })),
    };
    const applyLocalSyncConflictResolutionUsecase = {
      execute: jest.fn(() => Promise.resolve({ outcome: 'resolved', conflict: summary })),
    };
    const resolver = new SyncConflictResolver(
      listSyncConflictsUsecase as never,
      getSyncConflictUsecase as never,
      resolveSyncConflictUsecase as never,
      applyLocalSyncConflictResolutionUsecase as never,
    );
    return {
      resolver,
      resolveSyncConflictUsecase,
      applyLocalSyncConflictResolutionUsecase,
    };
  };

  it('保留本地：分派到管理员受控修订入口，不落到本地运行域用例', async () => {
    const { resolver, resolveSyncConflictUsecase, applyLocalSyncConflictResolutionUsecase } =
      build();

    const result = await resolver.resolveSyncConflict(user, 'c-1', 'LOCAL');

    expect(applyLocalSyncConflictResolutionUsecase.execute).toHaveBeenCalledWith(
      expect.objectContaining({ conflictId: 'c-1' }),
    );
    expect(resolveSyncConflictUsecase.execute).not.toHaveBeenCalled();
    expect(result.conflict?.conflictId).toBe('c-1');
  });

  it('使用云端与稍后处理：分派到本地运行域用例', async () => {
    for (const action of ['CLOUD', 'LATER'] as const) {
      const { resolver, resolveSyncConflictUsecase, applyLocalSyncConflictResolutionUsecase } =
        build();

      await resolver.resolveSyncConflict(user, 'c-1', action);

      expect(resolveSyncConflictUsecase.execute).toHaveBeenCalledWith(
        expect.objectContaining({ conflictId: 'c-1', action }),
      );
      expect(applyLocalSyncConflictResolutionUsecase.execute).not.toHaveBeenCalled();
    }
  });

  it('裁决返回体只带冲突摘要：不含本地/云端两份正文快照', async () => {
    const { resolver } = build();

    const result = await resolver.resolveSyncConflict(user, 'c-1', 'CLOUD');

    expect(result.conflict).not.toHaveProperty('localSnapshot');
    expect(result.conflict).not.toHaveProperty('cloudSnapshot');
  });
});
