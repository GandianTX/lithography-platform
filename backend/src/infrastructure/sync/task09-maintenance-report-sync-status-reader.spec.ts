// src/infrastructure/sync/task09-maintenance-report-sync-status-reader.spec.ts

/**
 * 任务 09 → 任务 07 同步状态适配器的单测（任务 09 剩余开发 S1）。
 *
 * 口径：
 * - 只读：只透传到 `SYNC_STATUS_QUERY`，不触发上传、不写回执；
 * - 完整键匹配：四字段（公司 + 类型 + UUID + 版本）原样传递；
 * - **版本不可核验即不产出条目**：不得回显调用方版本（会被误当作"版本一致"）；
 * - **状态越界即不产出条目**（如 AUTHORIZATION_INVALID）：由调用方按漏项降级 UNKNOWN；
 * - 越权记录由任务 09 侧授权裁决后不返回条目，调用方据此不展示该条同步列。
 */

import { IdentityTypeEnum } from '@app-types/models/account.types';
import type { UsecaseSession } from '@app-types/auth/session.types';

import { MaintenanceReportSyncStatusReaderAdapter } from './task09-maintenance-report-sync-status-reader';

const SESSION: UsecaseSession = {
  accountId: 900001,
  activeRole: IdentityTypeEnum.ENGINEER,
  roles: ['ENGINEER'],
};

const QUERY = {
  organizationId: 910001,
  resourceType: 'MAINTENANCE_REPORT',
  recordUuid: '6fd663eb-6d92-47be-9fbf-c591f7eb8e67',
  sourceVersion: 2,
};

const makeAdapter = (items: unknown[]) => {
  const queryStatuses = jest.fn().mockResolvedValue(items);
  const adapter = new MaintenanceReportSyncStatusReaderAdapter({
    queryStatuses,
  });

  return { adapter, queryStatuses };
};

describe('同步状态适配器（任务 09 → 任务 07）', () => {
  it('按完整四字段键透传查询，并回传条目', async () => {
    const { adapter, queryStatuses } = makeAdapter([
      {
        organizationId: 910001,
        resourceType: 'MAINTENANCE_REPORT',
        recordUuid: QUERY.recordUuid,
        sourceVersion: 2,
        identityPersisted: true,
        requestedVersion: 2,
        versionAligned: true,
        status: 'SYNCED',
        reasonCode: null,
        conflictId: null,
        canResolveConflict: false,
      },
    ]);

    const result = await adapter.fetchStatuses(SESSION, [QUERY]);

    expect(queryStatuses).toHaveBeenCalledWith({
      session: SESSION,
      requests: [QUERY],
    });
    expect(result.connected).toBe(true);
    expect(result.entries).toEqual([
      {
        organizationId: 910001,
        resourceType: 'MAINTENANCE_REPORT',
        recordUuid: QUERY.recordUuid,
        sourceVersion: 2,
        status: 'SYNCED',
        message: null,
        conflictId: null,
        canResolveConflict: false,
      },
    ]);
  });

  it('无可查记录时不触发查询', async () => {
    const { adapter, queryStatuses } = makeAdapter([]);

    const result = await adapter.fetchStatuses(SESSION, []);

    expect(queryStatuses).not.toHaveBeenCalled();
    expect(result).toEqual({ connected: true, entries: [] });
  });

  it('版本不可核验（sourceVersion=null）时不产出条目：不回显调用方版本', async () => {
    const { adapter } = makeAdapter([
      {
        organizationId: 910001,
        resourceType: 'MAINTENANCE_REPORT',
        recordUuid: QUERY.recordUuid,
        sourceVersion: null,
        identityPersisted: true,
        requestedVersion: 2,
        versionAligned: false,
        status: 'SYNCED',
        reasonCode: null,
        conflictId: null,
        canResolveConflict: false,
      },
    ]);

    const result = await adapter.fetchStatuses(SESSION, [QUERY]);

    expect(result.entries).toEqual([]);
  });

  it('状态越界（如 AUTHORIZATION_INVALID）不产出条目：由调用方降级 UNKNOWN', async () => {
    const { adapter } = makeAdapter([
      {
        organizationId: 910001,
        resourceType: 'MAINTENANCE_REPORT',
        recordUuid: QUERY.recordUuid,
        sourceVersion: 2,
        identityPersisted: true,
        requestedVersion: 2,
        versionAligned: true,
        status: 'AUTHORIZATION_INVALID',
        reasonCode: 'AUTHORIZATION_INVALID',
        conflictId: null,
        canResolveConflict: false,
      },
    ]);

    const result = await adapter.fetchStatuses(SESSION, [QUERY]);

    expect(result.entries).toEqual([]);
  });

  it('冲突条目保留冲突标识与处理权限（供调用方决定是否给处理入口）', async () => {
    const { adapter } = makeAdapter([
      {
        organizationId: 910001,
        resourceType: 'MAINTENANCE_REPORT',
        recordUuid: QUERY.recordUuid,
        sourceVersion: 2,
        identityPersisted: true,
        requestedVersion: 2,
        versionAligned: true,
        status: 'CONFLICT',
        reasonCode: 'CONFLICT_PRESENT',
        conflictId: 'conflict-1',
        canResolveConflict: true,
      },
    ]);

    const result = await adapter.fetchStatuses(SESSION, [QUERY]);

    expect(result.entries[0]).toMatchObject({
      status: 'CONFLICT',
      conflictId: 'conflict-1',
      canResolveConflict: true,
    });
  });

  it('查询异常向上抛出：调用方统一降级 UNKNOWN，不吞错成已同步', async () => {
    const queryStatuses = jest.fn().mockRejectedValue(new Error('sync status failed'));
    const adapter = new MaintenanceReportSyncStatusReaderAdapter({
      queryStatuses,
    });

    await expect(adapter.fetchStatuses(SESSION, [QUERY])).rejects.toThrow('sync status failed');
  });
});
