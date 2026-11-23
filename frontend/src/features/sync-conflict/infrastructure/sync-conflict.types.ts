// src/features/sync-conflict/infrastructure/sync-conflict.types.ts

/** 冲突资源类型（与后端同步来源类型一致） */
export type SyncConflictResourceType =
  | 'REFERENCE_DOCUMENT'
  | 'REPAIR_REQUEST'
  | 'MAINTENANCE_REPORT';

/** 冲突状态 */
export type SyncConflictStatus = 'PENDING' | 'RESOLVED' | 'IGNORED';

/** 冲突裁决动作 */
export type SyncConflictAction = 'LOCAL' | 'CLOUD' | 'LATER';

/** 差异条目类型 */
export type SyncConflictDiffKind = 'ONLY_LOCAL' | 'ONLY_CLOUD' | 'DIFFERENT';

/** 只读受控原因码 */
export type SyncConflictReadOnlyReason = 'SOURCE_WITHDRAWN' | 'SOURCE_FROZEN' | 'SOURCE_CLOSED';

/** 冲突清单条目（不含正文快照） */
export type SyncConflictSummary = {
  conflictId: string;
  recordUuid: string;
  resourceType: string;
  versionNo: number;
  localVersion: number | null;
  cloudVersion: number | null;
  displayedCloudVersion: number | null;
  decision: string | null;
  status: string;
  conflictReason: string;
  createdAt: string;
};

/** 冲突清单分页 */
export type SyncConflictListPage = {
  items: SyncConflictSummary[];
  total: number | null;
  page: number;
  pageSize: number;
  truncated: boolean | null;
};

/** 差异条目 */
export type SyncConflictDiffEntry = {
  path: string;
  kind: string;
  localValue: string | null;
  cloudValue: string | null;
};

/** 冲突详情（含正文快照与差异） */
export type SyncConflictDetail = SyncConflictSummary & {
  organizationId: number;
  localSnapshot: string;
  cloudSnapshot: string;
  diff: {
    entries: SyncConflictDiffEntry[];
    truncated: boolean;
    invalid: boolean;
  } | null;
  /** 来源记录的本机 ID（来源页入口用） */
  sourceRecordId: number | null;
  /** 来源内容是否只读（只读内容不得恢复或覆盖） */
  sourceReadOnly: boolean;
  /** 只读受控原因码 */
  sourceReadOnlyReason: string | null;
  /**
   * 是否允许采用云端视图（服务端裁决）。
   *
   * 已结单（结单后只读）允许**只读采用**；已删除／下架／冻结一律不允许。
   */
  canAdoptCloud: boolean;
  /** 是否为只读采用（来源已结单）：只呈现云端视图，不获得写入权 */
  adoptionReadOnly: boolean;
  confirmedByAccountId: number | null;
  confirmedAt: string | null;
};
