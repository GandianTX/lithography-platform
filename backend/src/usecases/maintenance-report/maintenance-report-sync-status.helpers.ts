// src/usecases/maintenance-report/maintenance-report-sync-status.helpers.ts
// 任务 07 同步状态预留的共用装配：先完成原有本人范围、组织与资源授权及页面读取，
// 再对当前页（或详情单条）最多批量调用一次同步状态读取，把可展示状态附着到记录上。
//
// 口径（backend/docs/api/task07-task09-sync-status-handoff.md）：
// - 匹配键 = 公司 + 资源类型 + 稳定记录 UUID + 当前业务版本，按完整键精确匹配，
//   不采用顺序匹配；
// - 只对具备可信映射的记录发起真实查询；公司取自服务端核实过的资源归属
//   （maintenance_report.owner_organization_id），不接受前端自报；
// - 当前报告表缺少跨端 UUID，草稿 current_version_no=0 不是同步版本：
//   映射缺失时不用本地 reportId、提交请求 ID、资料修订号或草稿 0 版本硬凑查询键；
// - 未装配（connected=false）展示 NOT_CONNECTED；已装配但映射缺失展示 UNKNOWN；
// - 提供方漏项、重复匹配、返回旧版本（键不一致）、状态越界或查询失败，
//   一律展示 UNKNOWN，不得显示已同步，也不影响原记录列表、total 与详情；
// - 原有授权错误发生在进入本装配之前，不会被这里的降级逻辑吞掉。

import type { MaintenanceReportSyncStatusDisplay } from '@src/modules/lithography/maintenance-report.types';
import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  MAINTENANCE_REPORT_SYNC_PROVIDER_STATUSES,
  MAINTENANCE_REPORT_SYNC_RESOURCE_TYPE,
  type MaintenanceReportSyncStatusBatch,
  type MaintenanceReportSyncStatusEntry,
  type MaintenanceReportSyncStatusQuery,
  type MaintenanceReportSyncStatusReader,
} from './ports/maintenance-report-sync-status-reader.contract';

/** 单条记录可用于构造同步查询键的可信事实（公司来自服务端核实过的资源归属） */
export type MaintenanceReportSyncKeyFacts = {
  ownerOrganizationId: number;
  /**
   * 跨端 UUID 的持久来源（`maintenance_report.record_uuid`，草案 §2 断点已消解）：
   * 历史行保持 NULL；为 NULL 时按"无稳定键"处理，不发真实查询。
   */
  recordUuid: string | null;
  /** 草稿 current_version_no=0 不是同步版本 */
  currentVersionNo: number;
};

/** 任务 09 未装配时的兜底展示值 */
export const NOT_CONNECTED_MAINTENANCE_REPORT_SYNC_STATUS: MaintenanceReportSyncStatusDisplay = {
  status: 'NOT_CONNECTED',
  message: null,
  conflictId: null,
  canResolveConflict: false,
};

/** 已装配但映射缺失 / 提供方结果不可采信 / 查询失败时的兜底展示值 */
export const UNKNOWN_MAINTENANCE_REPORT_SYNC_STATUS: MaintenanceReportSyncStatusDisplay = {
  status: 'UNKNOWN',
  message: null,
  conflictId: null,
  canResolveConflict: false,
};

/**
 * 提供方允许回报的状态集合。
 *
 * 唯一来源：`MAINTENANCE_REPORT_SYNC_PROVIDER_STATUSES`（端口层再导出）——
 * 任务 09 侧提供方适配器用的是同一份，不再各手写一遍。
 */
const PROVIDER_STATUSES: readonly string[] = MAINTENANCE_REPORT_SYNC_PROVIDER_STATUSES;

/** message 仅限面向用户的安全提示，硬性截断防止透传大段正文、内部错误或文件路径 */
const MAX_PROVIDER_MESSAGE_LENGTH = 200;

/**
 * 由可信事实构造同步状态查询键。
 * 跨端 UUID 缺失或当前业务版本缺失（草稿 0 版本）时返回 null：
 * 不给草稿填造假的 UUID 或版本，不发真实查询。
 */
export function buildMaintenanceReportSyncStatusQuery(
  facts: MaintenanceReportSyncKeyFacts,
): MaintenanceReportSyncStatusQuery | null {
  // 无稳定键（NULL／undefined／空串）一律不发真实查询：不得用本地 ID 或派生值硬凑查询键
  if (!facts.recordUuid) {
    return null;
  }
  if (facts.currentVersionNo <= 0) {
    return null;
  }
  return {
    organizationId: facts.ownerOrganizationId,
    resourceType: MAINTENANCE_REPORT_SYNC_RESOURCE_TYPE,
    recordUuid: facts.recordUuid,
    sourceVersion: facts.currentVersionNo,
  };
}

/** 提供方单条结果清洗：状态越界降级 UNKNOWN；处理入口仅在 CONFLICT + 有效冲突标识时保留 */
function sanitizeProviderEntry(
  entry: MaintenanceReportSyncStatusEntry,
): MaintenanceReportSyncStatusDisplay {
  if (!PROVIDER_STATUSES.includes(entry.status)) {
    return UNKNOWN_MAINTENANCE_REPORT_SYNC_STATUS;
  }
  const message =
    typeof entry.message === 'string' && entry.message.length > 0
      ? entry.message.slice(0, MAX_PROVIDER_MESSAGE_LENGTH)
      : null;
  const conflictId =
    typeof entry.conflictId === 'string' && entry.conflictId.length > 0 ? entry.conflictId : null;
  return {
    status: entry.status,
    message,
    conflictId,
    canResolveConflict:
      entry.status === 'CONFLICT' && conflictId !== null && entry.canResolveConflict,
  };
}

/** 完整键精确匹配（含 sourceVersion）：漏项、重复、返回旧版本均不判成功 */
function matchEntryByFullKey(
  entries: ReadonlyArray<MaintenanceReportSyncStatusEntry>,
  query: MaintenanceReportSyncStatusQuery,
): MaintenanceReportSyncStatusDisplay {
  const matched = entries.filter(
    (entry) =>
      entry.organizationId === query.organizationId &&
      entry.resourceType === query.resourceType &&
      entry.recordUuid === query.recordUuid &&
      entry.sourceVersion === query.sourceVersion,
  );
  if (matched.length !== 1) {
    return UNKNOWN_MAINTENANCE_REPORT_SYNC_STATUS;
  }
  return sanitizeProviderEntry(matched[0]);
}

/**
 * 批量读取同步状态并按记录 ID 附着展示值。
 * - records 为空时不调用提供方；
 * - 同一批次对提供方最多调用一次（queries 可为空数组，用于区分已装配/未装配）；
 * - 提供方整批失败时全部展示 UNKNOWN。
 */
export async function attachMaintenanceReportSyncStatuses(params: {
  reader: MaintenanceReportSyncStatusReader;
  /** 服务端可信会话：单独传递供提供方做记录级授权（草案 §2） */
  session: UsecaseSession;
  records: ReadonlyArray<{ id: number; facts: MaintenanceReportSyncKeyFacts }>;
}): Promise<Map<number, MaintenanceReportSyncStatusDisplay>> {
  const result = new Map<number, MaintenanceReportSyncStatusDisplay>();
  if (params.records.length === 0) {
    return result;
  }
  const queryByRecordId = new Map<number, MaintenanceReportSyncStatusQuery | null>();
  const queries: MaintenanceReportSyncStatusQuery[] = [];
  for (const record of params.records) {
    const query = buildMaintenanceReportSyncStatusQuery(record.facts);
    queryByRecordId.set(record.id, query);
    if (query !== null) {
      queries.push(query);
    }
  }

  let batch: MaintenanceReportSyncStatusBatch | null;
  try {
    batch = await params.reader.fetchStatuses(params.session, queries);
  } catch {
    // 查询失败统一降级为 UNKNOWN；不重试、不阻塞原记录读取
    batch = null;
  }

  for (const record of params.records) {
    const query = queryByRecordId.get(record.id) ?? null;
    if (batch === null || !batch.connected) {
      result.set(
        record.id,
        batch === null
          ? UNKNOWN_MAINTENANCE_REPORT_SYNC_STATUS
          : NOT_CONNECTED_MAINTENANCE_REPORT_SYNC_STATUS,
      );
      continue;
    }
    if (query === null) {
      result.set(record.id, UNKNOWN_MAINTENANCE_REPORT_SYNC_STATUS);
      continue;
    }
    result.set(record.id, matchEntryByFullKey(batch.entries, query));
  }
  return result;
}
