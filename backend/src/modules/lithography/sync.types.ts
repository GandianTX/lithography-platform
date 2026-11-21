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

/**
 * 冲突摘要（**不含正文快照**）。
 *
 * 用途：裁决结果的返回体。裁决是一次写动作，返回体没有必要再带两份正文快照
 * （本地快照与云端快照都含正文与原件引用）；摘要只给冲突元数据与裁决事实。
 */
export type SyncConflictSummary = Omit<SyncConflictSnapshot, 'localSnapshot' | 'cloudSnapshot'>;

/**
 * 裁决用的冲突视图（**不含正文快照**）：裁决路径只需要元数据与本地快照。
 * 由服务层返回，usecase 层不消费 ORM 实体。
 */
export type SyncConflictResolutionView = {
  conflictId: string;
  recordUuid: string;
  organizationId: number;
  resourceType: string;
  status: string;
  decision: string | null;
  localVersion: number | null;
  /** 本地快照 JSON 原文（保留本地裁决要映射的载荷来源） */
  localSnapshot: string;
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
  /** 候选超过扫描上限：可见集合是下界，如实标记，不静默丢条目 */
  truncated?: boolean;
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
