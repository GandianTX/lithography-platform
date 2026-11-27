// src/shared/i18n/local-backup-reason.ts

import { resolveControlledCodeKeyOrNull } from './controlled-code';
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
  LOCAL_UPLOAD_INTERRUPTED: 'local-backup.reason.uploadInterrupted',
  // 云端副本预检（云包不可得／摘要与大小不符／格式不支持／异机异公司）
  LOCAL_CLOUD_PACKAGES_UNAVAILABLE: 'local-backup.reason.cloudPackagesUnavailable',
  LOCAL_CLOUD_PACKAGE_UNAVAILABLE: 'local-backup.reason.cloudPackageUnavailable',
  LOCAL_CLOUD_PACKAGE_DIGEST_MISMATCH: 'local-backup.reason.cloudPackageDigestMismatch',
  LOCAL_CLOUD_PACKAGE_SIZE_MISMATCH: 'local-backup.reason.cloudPackageSizeMismatch',
  LOCAL_CLOUD_PACKAGE_SCHEMA_UNSUPPORTED: 'local-backup.reason.cloudPackageSchemaUnsupported',
  LOCAL_CLOUD_PACKAGE_DEVICE_MISMATCH: 'local-backup.reason.cloudPackageDeviceMismatch',
  LOCAL_CLOUD_PACKAGE_COMPANY_MISMATCH: 'local-backup.reason.cloudPackageCompanyMismatch',
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
  LOCAL_RESTORE_ORIGINAL_BYTES_MISSING: 'local-backup.reason.restoreOriginalBytesMissing',
  // 恢复执行失败（受控原因码；原始异常只进服务端日志）
  RESTORE_RUN_NOT_FOUND: 'local-backup.reason.restoreRunNotFound',
  RESTORE_NOT_ACCEPTED: 'local-backup.reason.restoreNotAccepted',
  RESTORE_CHECK_NOT_PASSED: 'local-backup.reason.restoreCheckNotPassed',
  RESTORE_INSTALLATION_MISSING: 'local-backup.reason.restoreInstallationMissing',
  RESTORE_VERIFY_FAILED: 'local-backup.reason.restoreVerifyFailed',
  RESTORE_EXECUTION_FAILED: 'local-backup.reason.restoreExecutionFailed',
  RESTORE_EXECUTION_ALREADY_RUNNING: 'local-backup.reason.restoreExecutionAlreadyRunning',
  RESTORE_SCOPE_OCCUPIED: 'local-backup.reason.restoreScopeOccupied',
  // 恢复执行占用（任务 09 独立验收 P1-2）：终态不得再次执行／跨公司／异机
  RESTORE_ALREADY_TERMINAL: 'local-backup.reason.restoreAlreadyTerminal',
  RESTORE_ORGANIZATION_NOT_ALLOWED: 'local-backup.reason.restoreOrganizationNotAllowed',
  RESTORE_INSTALLATION_MISMATCH: 'local-backup.reason.restoreInstallationMismatch',
  LOCAL_RESTORE_WRITE_FAILED: 'local-backup.reason.restoreWriteFailed',
  LOCAL_RESTORE_ROLLBACK_FAILED: 'local-backup.reason.restoreRollbackFailed',
  LOCAL_RESTORE_PROTECTION_UNREADABLE: 'local-backup.reason.restoreProtectionUnreadable',
  // 恢复执行能力（裁决在 core，adapter 只回受控码）
  RESTORE_EXECUTION_AVAILABLE: 'local-backup.reason.restoreExecutionAvailable',
  RESTORE_WRITE_GATE_UNAVAILABLE: 'local-backup.reason.restoreWriteGateUnavailable',
  RESTORE_FAILURE_COMPENSATION_UNAVAILABLE:
    'local-backup.reason.restoreFailureCompensationUnavailable',
  RESTORE_PROTECTION_KEY_UNAVAILABLE: 'local-backup.reason.restoreProtectionKeyUnavailable',
  // 保留窗口
  LOCAL_RETENTION_NOT_EXPIRED: 'local-backup.reason.retentionNotExpired',
  // 清理授权层原因码（本次手动备份未取得完整回执）
  CLOUD_RECEIPT_MISSING: 'local-backup.reason.cloudReceiptMissing',
  CLOUD_RECEIPT_UNPARSEABLE: 'local-backup.reason.cloudReceiptUnparsable',
  CLOUD_RECEIPT_NOT_SUCCESS: 'local-backup.reason.cloudReceiptNotSuccess',
  // 上云链：远端失败码（HTTP 客户端产出的 6 个）
  CLOUD_NOT_CONFIGURED: 'local-backup.reason.cloudNotConfigured',
  CLOUD_UNREACHABLE: 'local-backup.reason.cloudUnreachable',
  CLOUD_TIMEOUT: 'local-backup.reason.cloudTimeout',
  CLOUD_REJECTED: 'local-backup.reason.cloudRejected',
  CLOUD_SERVER_ERROR: 'local-backup.reason.cloudServerError',
  CLOUD_INVALID_RESPONSE: 'local-backup.reason.cloudInvalidResponse',
  // 上云链：本机备份包的结构性失败（终态，不再重试）
  CLOUD_PACKAGE_TOO_LARGE: 'local-backup.reason.packageTooLarge',
  CLOUD_PACKAGE_INCOMPLETE: 'local-backup.reason.packageIncomplete',
  CLOUD_PACKAGE_UNREADABLE: 'local-backup.reason.packageUnreadable',
};

/**
 * 受控原因码 → 文案键。
 *
 * 未知码返回 null（调用方用通用兜底文案），不把未知文本当文案直接渲染。
 */
export function resolveLocalBackupReasonKey(reason: string | null | undefined): MessageKey | null {
  return resolveControlledCodeKeyOrNull(REASON_MESSAGE_KEYS, reason);
}
