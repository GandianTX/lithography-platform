// src/features/sync-conflict/ui/sync-conflict-labels.ts

import type { MessageKey } from '@/shared/i18n';

/**
 * 冲突相关受控码 → 文案键映射（任务 09 S2.3）。
 *
 * 后端给的是**受控码**（资源类型、状态、裁决方向、差异类型、只读原因）；
 * 前端只把受控码映射成词条键，未知码回落到中性文案——不把机器码或
 * 后端自由文本原样透给用户（与任务 09 S1 的同步状态原因码同口径）。
 */

const RESOURCE_TYPE_KEYS: Record<string, MessageKey> = {
  MAINTENANCE_REPORT: 'syncConflict.resourceType.MAINTENANCE_REPORT',
  REFERENCE_DOCUMENT: 'syncConflict.resourceType.REFERENCE_DOCUMENT',
  REPAIR_REQUEST: 'syncConflict.resourceType.REPAIR_REQUEST',
};

const STATUS_KEYS: Record<string, MessageKey> = {
  IGNORED: 'syncConflict.status.IGNORED',
  PENDING: 'syncConflict.status.PENDING',
  RESOLVED: 'syncConflict.status.RESOLVED',
};

const DECISION_KEYS: Record<string, MessageKey> = {
  CLOUD: 'syncConflict.decision.CLOUD',
  LOCAL: 'syncConflict.decision.LOCAL',
  PENDING: 'syncConflict.decision.PENDING',
};

const DIFF_KIND_KEYS: Record<string, MessageKey> = {
  DIFFERENT: 'syncConflict.detail.diff.kind.different',
  ONLY_CLOUD: 'syncConflict.detail.diff.kind.onlyCloud',
  ONLY_LOCAL: 'syncConflict.detail.diff.kind.onlyLocal',
};

const READ_ONLY_KEYS: Record<string, MessageKey> = {
  SOURCE_CLOSED: 'syncConflict.readOnly.SOURCE_CLOSED',
  SOURCE_FROZEN: 'syncConflict.readOnly.SOURCE_FROZEN',
  SOURCE_WITHDRAWN: 'syncConflict.readOnly.SOURCE_WITHDRAWN',
};

/** 资源类型文案键 */
export function resolveSyncConflictResourceTypeKey(value: string): MessageKey {
  return RESOURCE_TYPE_KEYS[value] ?? 'syncConflict.resourceType.OTHER';
}

/** 处理状态文案键 */
export function resolveSyncConflictStatusKey(value: string): MessageKey {
  return STATUS_KEYS[value] ?? 'syncConflict.status.OTHER';
}

/** 裁决方向文案键 */
export function resolveSyncConflictDecisionKey(value: string): MessageKey {
  return DECISION_KEYS[value] ?? 'syncConflict.decision.OTHER';
}

/** 差异类型文案键 */
export function resolveSyncConflictDiffKindKey(value: string): MessageKey {
  return DIFF_KIND_KEYS[value] ?? 'syncConflict.detail.diff.kind.different';
}

/** 只读原因文案键 */
export function resolveSyncConflictReadOnlyKey(value: string): MessageKey {
  return READ_ONLY_KEYS[value] ?? 'syncConflict.action.readOnlyNotice';
}
