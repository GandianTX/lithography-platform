// src/usecases/maintenance-report/ports/maintenance-report-sync-status-reader.contract.ts
// 任务 07 → 任务 09 同步状态批量读取的窄边界（预留）。
//
// 对接依据：backend/docs/api/task07-task09-sync-status-handoff.md（v0.1 对接草案，
// 不是任务 09 已承诺的 API）。约束：
// - 请求按四字段完整键精确匹配：公司、资源类型、稳定记录 UUID、当前业务版本；
//   不采用顺序匹配；
// - 调用者身份由服务端可信会话单独传递，不在载荷中接受浏览器自报；
// - 默认装配为「明确不可用」实现：不查同步表、不请求外部服务、不触发队列；
//   测试通过 DI 注入替身，不提供公开模拟接口或生产开关；
// - 本接口的任何失败由调用方统一降级为 UNKNOWN，不得影响原记录列表、total 与详情。

import {
  MAINTENANCE_REPORT_SYNC_PROVIDER_STATUSES,
  type MaintenanceReportSyncProviderStatus,
  type MaintenanceReportSyncStatusDisplay,
} from '@src/modules/lithography/maintenance-report.types';
import type { UsecaseSession } from '@app-types/auth/session.types';

export const MAINTENANCE_REPORT_SYNC_STATUS_READER = Symbol(
  'MAINTENANCE_REPORT_SYNC_STATUS_READER',
);

/**
 * 待任务 09 确认的资源类型值（草案样例值，不是现行枚举）。
 * 独立历史报告/工单总结是报告的 source_type，不得直接当同步资源类型使用；
 * local_upload_task.entity_type 是分项类型，也不是同一字段。
 */
export const MAINTENANCE_REPORT_SYNC_RESOURCE_TYPE = 'MAINTENANCE_REPORT';

/**
 * 提供方允许回报的状态集合（NOT_CONNECTED／UNKNOWN 由调用方自身判定，不接受回报）。
 * 在本端口层重新导出，使实现方（infrastructure 层）无需依赖 modules 层类型。
 */
export type { MaintenanceReportSyncProviderStatus };

/** 提供方可回报状态的运行时白名单（唯一来源，见端口层再导出说明） */
export { MAINTENANCE_REPORT_SYNC_PROVIDER_STATUSES };

/** 同步状态查询键：四字段完整匹配（含 sourceVersion），提供方漏项/重复/旧版本均不判成功 */
export type MaintenanceReportSyncStatusQuery = {
  organizationId: number;
  resourceType: string;
  recordUuid: string;
  sourceVersion: number;
};

/** 提供方返回的单条状态：附完整键，供调用方按完整键核对而非按下标采信 */
export type MaintenanceReportSyncStatusEntry = MaintenanceReportSyncStatusQuery &
  MaintenanceReportSyncStatusDisplay;

export type MaintenanceReportSyncStatusBatch = {
  /** false=尚未装配任务 09 实现（默认不可用实现恒为 false）；true=提供方已装配 */
  connected: boolean;
  entries: MaintenanceReportSyncStatusEntry[];
};

export interface MaintenanceReportSyncStatusReader {
  /**
   * 批量读取同步状态；同一列表页（或详情单条）每轮最多调用一次。
   * 实现不得返回模拟成功；任务状态与回执矛盾时由实现明确裁决。
   *
   * `session` 是**服务端可信会话**（草案 §2：调用者身份由服务端可信会话单独传递，
   * 不在载荷中接受浏览器自报）：实现据此做记录级授权，
   * 越权记录不返回条目，调用方不展示该条的同步列。
   */
  fetchStatuses(
    session: UsecaseSession,
    queries: MaintenanceReportSyncStatusQuery[],
  ): Promise<MaintenanceReportSyncStatusBatch>;
}
