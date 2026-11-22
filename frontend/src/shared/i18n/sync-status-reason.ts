// src/shared/i18n/sync-status-reason.ts

import { resolveControlledCodeKeyOrNull } from './controlled-code';
import type { MessageKey } from './types';

/**
 * 后端同步状态受控原因码 → 界面文案键（任务 09 S1）。
 *
 * 为什么需要这一层：
 * - 后端对外只给**受控原因码**（`sync-status.policy.ts` 的 `syncStatusReasonCodeEnum`），
 *   原始异常与内部细节只进服务端日志；
 * - 界面不能直接渲染机器码：未知码一律走通用兜底文案，
 *   避免把后端自由文本原样透给用户。
 *
 * 词条键由中文词条表推导（`MessageKey`），英文侧同键同义。
 */
const REASON_MESSAGE_KEYS: Readonly<Record<string, MessageKey>> = {
  // 接入与可信度
  NOT_CONNECTED: 'sync-status.reason.notConnected',
  IDENTITY_UNTRUSTED: 'sync-status.reason.identityUntrusted',
  VERSION_UNTRUSTED: 'sync-status.reason.versionUntrusted',
  APPLICABILITY_UNKNOWN: 'sync-status.reason.applicabilityUnknown',
  AUTHORIZATION_INVALID: 'sync-status.reason.authorizationInvalid',
  // 回执
  RECEIPT_MISSING: 'sync-status.reason.receiptMissing',
  RECEIPT_VERSION_MISMATCH: 'sync-status.reason.receiptVersionMismatch',
  RECEIPT_INCOMPLETE: 'sync-status.reason.receiptIncomplete',
  RECEIPT_STATUS_UNKNOWN: 'sync-status.reason.receiptStatusUnknown',
  RECEIPT_SOURCE_UNCONFIRMED: 'sync-status.reason.receiptSourceUnconfirmed',
  // 任务
  TASK_RECEIPT_INCONSISTENT: 'sync-status.reason.taskReceiptInconsistent',
  TASK_FAILED: 'sync-status.reason.taskFailed',
  TASK_CANCELLED: 'sync-status.reason.taskCancelled',
  TASK_KIND_UNKNOWN: 'sync-status.reason.taskKindUnknown',
  TASK_STATUS_UNKNOWN: 'sync-status.reason.taskStatusUnknown',
  TASK_NOT_BODY: 'sync-status.reason.taskNotBody',
  // 冲突
  CONFLICT_PENDING: 'sync-status.reason.conflictPending',
};

/**
 * 受控原因码 → 文案键。
 *
 * 未知码返回 null（调用方用通用兜底文案），不把未知文本当文案直接渲染。
 */
export function resolveSyncStatusReasonKey(reason: string | null | undefined): MessageKey | null {
  return resolveControlledCodeKeyOrNull(REASON_MESSAGE_KEYS, reason);
}
