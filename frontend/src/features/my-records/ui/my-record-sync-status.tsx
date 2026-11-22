// src/features/my-records/ui/my-record-sync-status.tsx

import { Tag } from 'antd';
import type { ReactNode } from 'react';

import { useI18n } from '@/shared/i18n';

import type { MyRecordSyncStatusView } from '../infrastructure/my-records.types';

import { canOfferConflictResolution, resolveSyncStatusLabelKey } from './my-record-labels';

/**
 * 同步状态标签（任务 07 预留）。
 *
 * - 同步状态与「草稿／已入库」独立：不从保存成功推断「已同步」，标签只反映
 *   后端适配层给出的展示状态（任务 09 未接入前恒为 NOT_CONNECTED）；
 * - 当前网页版默认隐藏同步列（本组件暂无调用方），逻辑保留供以后开启；
 * - 「处理冲突」入口仅在三条件齐备时渲染（见 canOfferConflictResolution）且
 *   调用方传入已接入的真实路由动作；本轮无已接入路由，不出现占位跳转。
 */
const SYNC_STATUS_TAG_COLORS: Record<string, string> = {
  NOT_CONNECTED: 'default',
  UNKNOWN: 'default',
  NOT_APPLICABLE: 'default',
  NO_TASK: 'default',
  PENDING: 'default',
  UPLOADING: 'processing',
  FAILED: 'error',
  SYNCED: 'success',
  CONFLICT: 'warning',
};

export function MyRecordSyncStatusBadge({
  view,
  conflictAction,
}: {
  view: MyRecordSyncStatusView;
  /** 已接入的冲突处理动作（真实路由按钮）；本轮无已接入路由，一律不传 */
  conflictAction?: ReactNode;
}) {
  const { t } = useI18n();

  return (
    <span className="inline-flex items-center gap-2">
      <Tag
        color={SYNC_STATUS_TAG_COLORS[view.status] ?? 'default'}
        title={view.message ?? undefined}
      >
        {t(resolveSyncStatusLabelKey(view.status))}
      </Tag>
      {canOfferConflictResolution(view) && conflictAction !== undefined ? conflictAction : null}
    </span>
  );
}
