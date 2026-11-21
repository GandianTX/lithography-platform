// src/modules/lithography/sync.types.ts

import type {
  SyncConflictAction,
  SyncConflictDecision,
} from '@core/local-runtime/policy/sync-conflict-resolve.policy';

/**
 * 本地业务同步读模型契约（任务 09 S2，R065–R069）。
 *
 * - `sync_conflict` 没有 `installation_id` 列：同一台设备只有一个安装，
 *   公司数据区就是隔离边界（`organization_id`）；
 * - 快照在库中是 JSON 文本，读模型原样搬运，不在这里做字段级解释；
 * - `confirmedByAccountId`／`confirmedAt` 只在 RESOLVED／IGNORED 时非空
 *   （DB CHECK 强制），读模型不做二次加工。
 */
export type SyncConflictSnapshot = {
  conflictId: string;
  recordUuid: string;
  organizationId: number;
  resourceType: string;
  versionNo: number;
  localVersion: number | null;
  cloudVersion: number | null;
  displayedCloudVersion: number | null;
  decision: SyncConflictDecision | null;
  status: 'PENDING' | 'RESOLVED' | 'IGNORED';
  /** 本地快照 JSON 原文（含正文与原件引用） */
  localSnapshot: string;
  /** 云端快照 JSON 原文 */
  cloudSnapshot: string;
  /** 可展示的冲突原因 */
  conflictReason: string;
  confirmedByAccountId: number | null;
  confirmedAt: Date | null;
  createdAt: Date;
};

export type SyncConflictListPagination = {
  page: number;
  pageSize: number;
  withTotal?: boolean;
};

export type SyncConflictListPage = {
  items: SyncConflictSnapshot[];
  total?: number;
  page: number;
  pageSize: number;
};

export type SyncConflictListFilters = {
  /** 只看待处理；缺省返回全部状态 */
  statusOnlyPending?: boolean;
};

export type SyncConflictResolveCommand = {
  conflictId: string;
  action: SyncConflictAction;
  confirmedByAccountId: number;
};

export type SyncConflictResolveResult = {
  /** 冲突快照（裁决后的最新事实） */
  conflict: SyncConflictSnapshot;
  /** 'existing'：重复请求返回既有事实，不重复写 */
  outcome: 'existing' | 'later' | 'resolved';
};
