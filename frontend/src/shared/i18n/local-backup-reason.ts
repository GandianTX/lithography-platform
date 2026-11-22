// src/shared/i18n/local-backup-reason.ts

import type { MessageKey } from './types';

/**
 * 后端受控原因码 → 界面文案键（任务 09 S3/S4）。
 *
 * 为什么需要这一层：
 * - 后端对外只给**受控原因码**（`LOCAL_*` 与清理授权层的 `CLOUD_*`），
 *   原始异常与本机绝对路径只进服务端日志；
 * - 界面不能直接渲染机器码，也不能把自由文本当契约：
 *   未知码一律走通用兜底文案，避免把后端自由文本原样透给用户。
 *
 * 词条键由中文词条表推导（`MessageKey`），英文侧同键同义。
 */
const REASON_MESSAGE_KEYS: Readonly<Record<string, MessageKey>> = {
  // 清理相关
  LOCAL_PACKAGE_REFERENCE_MISSING: 'local-backup.reason.packageReferenceMissing',
  LOCAL_PACKAGE_PATH_OUTSIDE_ROOT: 'local-backup.reason.packagePathOutsideRoot',
  LOCAL_PACKAGE_DELETE_FAILED: 'local-backup.reason.packageDeleteFailed',
  LOCAL_CLEANUP_INTERRUPTED: 'local-backup.reason.cleanupInterrupted',
  LOCAL_PACKAGE_ALREADY_CLEANED: 'local-backup.reason.packageAlreadyCleaned',
  LOCAL_CLEANUP_RETAINED: 'local-backup.reason.cleanupRetained',
  // 上云相关
  LOCAL_UPLOAD_RECEIVER_MISSING: 'local-backup.reason.uploadReceiverMissing',
  LOCAL_UPLOAD_FAILED: 'local-backup.reason.uploadFailed',
  // 备份与恢复预检
  LOCAL_BACKUP_GENERATION_FAILED: 'local-backup.reason.backupGenerationFailed',
  LOCAL_PROTECTION_COPY_FAILED: 'local-backup.reason.protectionCopyFailed',
  LOCAL_PACKAGE_MANIFEST_MISSING: 'local-backup.reason.packageManifestMissing',
  LOCAL_PACKAGE_MANIFEST_UNPARSABLE: 'local-backup.reason.packageManifestUnparsable',
  LOCAL_PACKAGE_FILE_MISSING: 'local-backup.reason.packageFileMissing',
  LOCAL_PACKAGE_FILE_SIZE_MISMATCH: 'local-backup.reason.packageFileSizeMismatch',
  LOCAL_PACKAGE_FILE_CHECKSUM_MISMATCH: 'local-backup.reason.packageFileChecksumMismatch',
  // 恢复预检目标核对
  LOCAL_RESTORE_TARGET_INSTALLATION_MISMATCH:
    'local-backup.reason.restoreTargetInstallationMismatch',
  LOCAL_RESTORE_TARGET_ORGANIZATION_MISMATCH:
    'local-backup.reason.restoreTargetOrganizationMismatch',
  LOCAL_RESTORE_LOCAL_PACKAGE_MISSING: 'local-backup.reason.restoreLocalPackageMissing',
  // 保留窗口
  LOCAL_RETENTION_NOT_EXPIRED: 'local-backup.reason.retentionNotExpired',
  // 清理授权层原因码（本次手动备份未取得完整回执）
  CLOUD_RECEIPT_MISSING: 'local-backup.reason.cloudReceiptMissing',
  CLOUD_RECEIPT_UNPARSEABLE: 'local-backup.reason.cloudReceiptUnparsable',
  CLOUD_RECEIPT_NOT_SUCCESS: 'local-backup.reason.cloudReceiptNotSuccess',
};

/**
 * 受控原因码 → 文案键。
 *
 * 未知码返回 null（调用方用通用兜底文案），不把未知文本当文案直接渲染。
 */
export function resolveLocalBackupReasonKey(reason: string | null | undefined): MessageKey | null {
  if (typeof reason !== 'string' || reason.length === 0) {
    return null;
  }
  return REASON_MESSAGE_KEYS[reason] ?? null;
}
