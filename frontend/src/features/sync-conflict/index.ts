// src/features/sync-conflict/index.ts

export { useSyncConflictDetail } from './application/use-sync-conflict-detail';
export { useSyncConflictList } from './application/use-sync-conflict-list';
export type {
  SyncConflictAction,
  SyncConflictDetail,
  SyncConflictDiffEntry,
  SyncConflictListPage,
  SyncConflictReadOnlyReason,
  SyncConflictResourceType,
  SyncConflictStatus,
  SyncConflictSummary,
} from './infrastructure/sync-conflict.types';
export { SyncConflictDetailPanel } from './ui/sync-conflict-detail-panel';
export { SyncConflictList } from './ui/sync-conflict-list';
export { resolveSyncConflictSourcePath } from './ui/sync-conflict-paths';
