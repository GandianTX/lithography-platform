// src/features/sync-conflict/ui/sync-conflict-paths.ts

/**
 * 来源页入口路径解析（任务 09 S2.3）。
 *
 * 冲突只带稳定业务编号（跨端一致）与**本机**记录 ID；来源页按本机 ID 路由，
 * 因此取不到本机 ID（记录已删除／归属变更／资源类型未知）时**不提供跳转**——
 * 猜一个可能指错的路径比不给入口更糟。
 */
export function resolveSyncConflictSourcePath(input: {
  resourceType: string;
  sourceRecordId: number | null;
}): string | null {
  if (input.sourceRecordId === null || input.sourceRecordId <= 0) {
    return null;
  }

  switch (input.resourceType) {
    case 'REPAIR_REQUEST':
      return `/engineer/repair-requests/${input.sourceRecordId}`;
    case 'REFERENCE_DOCUMENT':
      return `/reference-documents/${input.sourceRecordId}`;
    case 'MAINTENANCE_REPORT':
      return `/engineer/records/${input.sourceRecordId}`;
    default:
      return null;
  }
}
