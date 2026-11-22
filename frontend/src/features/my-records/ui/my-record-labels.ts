// src/features/my-records/ui/my-record-labels.ts

import type { MessageKey } from '@/shared/i18n';

import type { MyRecordSourceType, MyRecordSyncStatus } from '../infrastructure/my-records.types';

/** 状态展示键：未知状态回落 unknown（任务 06 后续新增状态时只需补词条） */
export const MY_RECORD_STATUS_LABEL_KEYS: Record<string, MessageKey> = {
  DRAFT: 'myRecords.status.draft',
  RETURNED: 'myRecords.status.returned',
  PENDING_REVIEW: 'myRecords.status.pending',
  APPROVED: 'myRecords.status.approved',
  SUBMITTED: 'myRecords.status.submitted',
  UNKNOWN: 'myRecords.status.unknown',
};

export const MY_RECORD_SOURCE_LABEL_KEYS: Record<MyRecordSourceType, MessageKey> = {
  HISTORICAL_CASE: 'myRecords.source.independent',
  WORK_ORDER_SUMMARY: 'myRecords.source.workOrder',
};

export function resolveStatusLabelKey(status: string): MessageKey {
  return MY_RECORD_STATUS_LABEL_KEYS[status] ?? 'myRecords.status.unknown';
}

/** 同步状态展示键（任务 07 预留；与「草稿／已入库」标签相互独立） */
export const MY_RECORD_SYNC_STATUS_LABEL_KEYS: Record<MyRecordSyncStatus, MessageKey> = {
  NOT_CONNECTED: 'myRecords.sync.notConnected',
  UNKNOWN: 'myRecords.sync.unknown',
  NOT_APPLICABLE: 'myRecords.sync.notApplicable',
  NO_TASK: 'myRecords.sync.noTask',
  PENDING: 'myRecords.sync.pending',
  UPLOADING: 'myRecords.sync.uploading',
  FAILED: 'myRecords.sync.failed',
  SYNCED: 'myRecords.sync.synced',
  CONFLICT: 'myRecords.sync.conflict',
};

export function resolveSyncStatusLabelKey(status: string): MessageKey {
  return MY_RECORD_SYNC_STATUS_LABEL_KEYS[status as MyRecordSyncStatus] ?? 'myRecords.sync.unknown';
}

/**
 * 是否具备展示「处理冲突」入口的三个后端事实条件：
 * 当前版本确有冲突（CONFLICT + conflictId）且任务 09 明确授权（canResolveConflict）。
 * 实际渲染还要求调用方传入已接入的真实路由动作；处理时任务 09 仍须重新核权。
 */
export function canOfferConflictResolution(view: {
  status: MyRecordSyncStatus;
  conflictId: string | null;
  canResolveConflict: boolean;
}): boolean {
  return view.status === 'CONFLICT' && view.conflictId !== null && view.canResolveConflict;
}
