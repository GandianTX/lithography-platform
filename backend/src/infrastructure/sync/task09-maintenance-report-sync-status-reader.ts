// src/infrastructure/sync/task09-maintenance-report-sync-status-reader.ts

/**
 * 任务 09 → 任务 07 的同步状态读取适配器（handoff §1「任务 09 提供真实实现」）。
 *
 * 定位：把任务 09 的窄边界 `SYNC_STATUS_QUERY`（`sync-status.contract.ts`）
 * 适配成任务 07 的 `MaintenanceReportSyncStatusReader` 端口
 * （`usecases/maintenance-report/ports/maintenance-report-sync-status-reader.contract.ts`）。
 *
 * 口径：
 * - **只读**：不查外部服务、不触发上传、不写回执、不改状态；
 * - **完整键匹配**：按「公司 + 资源类型 + 稳定 UUID + 当前版本」四字段精确匹配，
 *   不采用顺序匹配；提供方漏项／重复／键不一致一律不采信；
 * - **版本不可核验即不产出条目**：服务端认定的当前版本为 null（来源事实不可核验）时
 *   跳过该条——回显调用方版本会被误当作"版本一致"，故按漏项处理，由调用方降级 UNKNOWN；
 * - **授权在服务端**：可信会话单独传入，记录级授权由任务 09 侧裁决；
 *   越权记录不返回条目（调用方据此不展示该条同步列）；
 * - **失败关闭**：查询异常由调用方统一降级为 UNKNOWN，本实现不吞错成"已同步"。
 */

import { Inject, Injectable } from '@nestjs/common';

import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  MAINTENANCE_REPORT_SYNC_PROVIDER_STATUSES,
  type MaintenanceReportSyncStatusBatch,
  type MaintenanceReportSyncStatusEntry,
  type MaintenanceReportSyncProviderStatus,
  type MaintenanceReportSyncStatusQuery,
  type MaintenanceReportSyncStatusReader,
} from '@usecases/maintenance-report/ports/maintenance-report-sync-status-reader.contract';

import {
  SYNC_STATUS_QUERY,
  type SyncStatusQueryPort,
} from '@src/usecases/local-runtime/sync-status.contract';

/**
 * 任务 07 侧允许回报的状态集合。
 *
 * 唯一来源：端口层再导出的 `MAINTENANCE_REPORT_SYNC_PROVIDER_STATUSES`
 * （与任务 07 helpers 用的是同一份常量，不再各手写一遍，避免状态集合漂移）。
 * NOT_CONNECTED／UNKNOWN 由调用方自身判定，不接受回报。
 */
const PROVIDER_STATUSES: readonly MaintenanceReportSyncProviderStatus[] =
  MAINTENANCE_REPORT_SYNC_PROVIDER_STATUSES;

/** 状态白名单守卫：越界状态（如 AUTHORIZATION_INVALID）一律不产出条目 */
function isProviderStatus(value: string): value is MaintenanceReportSyncProviderStatus {
  return (PROVIDER_STATUSES as readonly string[]).includes(value);
}

@Injectable()
export class MaintenanceReportSyncStatusReaderAdapter implements MaintenanceReportSyncStatusReader {
  constructor(@Inject(SYNC_STATUS_QUERY) private readonly syncStatusQuery: SyncStatusQueryPort) {}

  async fetchStatuses(
    session: UsecaseSession,
    queries: MaintenanceReportSyncStatusQuery[],
  ): Promise<MaintenanceReportSyncStatusBatch> {
    // 无可查记录：按"已装配但无请求"返回空批次，不触发任何查询
    if (queries.length === 0) {
      return { connected: true, entries: [] };
    }

    const items = await this.syncStatusQuery.queryStatuses({
      session,
      requests: queries.map((query) => ({
        organizationId: query.organizationId,
        resourceType: query.resourceType,
        recordUuid: query.recordUuid,
        sourceVersion: query.sourceVersion,
      })),
    });

    const entries: MaintenanceReportSyncStatusEntry[] = [];
    for (const item of items) {
      // 版本不可核验 → 不产出条目（由调用方按漏项降级 UNKNOWN），不回显调用方版本
      if (item.sourceVersion === null) {
        continue;
      }
      // 状态越界（如 AUTHORIZATION_INVALID / NOT_CONNECTED / UNKNOWN）不在任务 07 的
      // 可展示集合内 → 同样不产出条目，由调用方按漏项降级 UNKNOWN（不得展示越界状态）
      if (!isProviderStatus(item.status)) {
        continue;
      }
      entries.push({
        organizationId: item.organizationId,
        resourceType: item.resourceType,
        recordUuid: item.recordUuid,
        sourceVersion: item.sourceVersion,
        status: item.status,
        message: item.reasonCode,
        conflictId: item.conflictId,
        canResolveConflict: item.canResolveConflict,
      });
    }

    return { connected: true, entries };
  }
}
