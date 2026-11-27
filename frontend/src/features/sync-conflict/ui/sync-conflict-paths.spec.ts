// src/features/sync-conflict/ui/sync-conflict-paths.spec.ts

/**
 * 来源页入口解析定向测试（任务 09 S2.3）。
 *
 * 守住：取不到本机 ID 时**不给跳转**（不猜路径）；三类资源各自落到既有来源页路由。
 */

import { describe, expect, it } from 'vitest';

import { resolveSyncConflictSourcePath } from './sync-conflict-paths';

describe('同步冲突来源页入口', () => {
  it('工单 → 工单详情页', () => {
    expect(
      resolveSyncConflictSourcePath({ resourceType: 'REPAIR_REQUEST', sourceRecordId: 880001 }),
    ).toBe('/engineer/repair-requests/880001');
  });

  it('资料 → 资料详情页', () => {
    expect(
      resolveSyncConflictSourcePath({
        resourceType: 'REFERENCE_DOCUMENT',
        sourceRecordId: 12,
      }),
    ).toBe('/reference-documents/12');
  });

  it('维修报告 → 我的记录详情页', () => {
    expect(
      resolveSyncConflictSourcePath({
        resourceType: 'MAINTENANCE_REPORT',
        sourceRecordId: 34,
      }),
    ).toBe('/engineer/records/34');
  });

  it('取不到本机 ID 时不给入口', () => {
    expect(
      resolveSyncConflictSourcePath({ resourceType: 'REPAIR_REQUEST', sourceRecordId: null }),
    ).toBeNull();
  });

  it('未知资源类型不给入口', () => {
    expect(resolveSyncConflictSourcePath({ resourceType: 'OTHER', sourceRecordId: 1 })).toBeNull();
  });
});
