// src/infrastructure/sync/unavailable-maintenance-report-sync-status-reader.spec.ts
// 默认装配的明确不可用实现：零 I/O、恒为未装配（connected=false）、不伪造任何状态。

/// <reference types="jest" />

import { UnavailableMaintenanceReportSyncStatusReader } from './unavailable-maintenance-report-sync-status-reader';

describe('UnavailableMaintenanceReportSyncStatusReader（默认适配）', () => {
  it('恒返回未装配（connected=false）且无任何条目，不触发 I/O', async () => {
    const reader = new UnavailableMaintenanceReportSyncStatusReader();

    await expect(
      reader.fetchStatuses([
        {
          organizationId: 101,
          resourceType: 'MAINTENANCE_REPORT',
          recordUuid: '6fd663eb-6d92-47be-9fbf-c591f7eb8e67',
          sourceVersion: 1,
        },
      ]),
    ).resolves.toEqual({ connected: false, entries: [] });
  });
});
