// src/infrastructure/sync/unavailable-maintenance-report-sync-status-reader.ts
// 任务 09 同步状态提供方未接入时的明确不可用实现（boundary contract 的 infrastructure 实现）。
// 不查同步表、不请求外部服务、不触发队列、无任何 I/O；调用方据此把同步状态展示为
// NOT_CONNECTED，不得从保存成功推断「已同步」，也不得伪造任务或回执。
// 测试通过 DI 注入替身（overrideProvider），不提供公开模拟接口或生产开关。

import { Injectable } from '@nestjs/common';
import type {
  MaintenanceReportSyncStatusBatch,
  MaintenanceReportSyncStatusQuery,
  MaintenanceReportSyncStatusReader,
} from '@usecases/maintenance-report/ports/maintenance-report-sync-status-reader.contract';

@Injectable()
export class UnavailableMaintenanceReportSyncStatusReader implements MaintenanceReportSyncStatusReader {
  fetchStatuses(
    _queries: MaintenanceReportSyncStatusQuery[],
  ): Promise<MaintenanceReportSyncStatusBatch> {
    // 纯内存返回：connected=false 表示任务 09 尚未装配
    return Promise.resolve({ connected: false, entries: [] });
  }
}
