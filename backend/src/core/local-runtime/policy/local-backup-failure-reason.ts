// src/core/local-runtime/policy/local-backup-failure-reason.ts
//
// 受控失败原因码（任务 09：本地备份包的清理／自动上云／手动备份／恢复预检）。
//
// 为什么需要这一层（口径）：
// - 此前这些路径把**底层异常原文**（Node fs 异常含本机绝对路径）直接回显到
//   返回值、落库原因列，并经 GraphQL 字段下发到前端：既泄露本机目录布局，
//   也不是受控文案、无法本地化，前端只能原样渲染；
// - 改为：对外（返回值／DTO／落库原因列）只给**受控原因码**，
//   原始异常只进服务端日志，不进任何对外字段；
// - 前端按码映射文案：未知码一律走通用兜底，不把自由文本当契约。
//
// 取值口径：全部为 `LOCAL_` 前缀的稳定标识；**不得**在此登记含路径、凭据或
// 他人正文的自由文本。

export const LOCAL_BACKUP_FAILURE_REASON = {
  /** 本地包引用缺失，无需清理 */
  PACKAGE_REFERENCE_MISSING: 'LOCAL_PACKAGE_REFERENCE_MISSING',
  /** 本地包路径不在本机备份目录内，拒绝删除 */
  PACKAGE_PATH_OUTSIDE_ROOT: 'LOCAL_PACKAGE_PATH_OUTSIDE_ROOT',
  /** 本地包删除失败（底层原因只进服务端日志） */
  PACKAGE_DELETE_FAILED: 'LOCAL_PACKAGE_DELETE_FAILED',
  /** 清理被进程中断，将在本轮重试 */
  CLEANUP_INTERRUPTED: 'LOCAL_CLEANUP_INTERRUPTED',
  /** 云接收端未接入，自动上云不可用 */
  UPLOAD_RECEIVER_MISSING: 'LOCAL_UPLOAD_RECEIVER_MISSING',
  /** 云端上传失败（底层原因只进服务端日志） */
  UPLOAD_FAILED: 'LOCAL_UPLOAD_FAILED',
  /** 备份包生成失败（底层原因只进服务端日志） */
  BACKUP_GENERATION_FAILED: 'LOCAL_BACKUP_GENERATION_FAILED',
  /** 保护副本生成失败（底层原因只进服务端日志） */
  PROTECTION_COPY_FAILED: 'LOCAL_PROTECTION_COPY_FAILED',
  /** 本机备份包缺少清单文件，无法核对完整性 */
  PACKAGE_MANIFEST_MISSING: 'LOCAL_PACKAGE_MANIFEST_MISSING',
  /** 本机备份包的清单无法解析，无法核对完整性 */
  PACKAGE_MANIFEST_UNPARSABLE: 'LOCAL_PACKAGE_MANIFEST_UNPARSABLE',
  /** 备份包缺少文件，无法核对完整性 */
  PACKAGE_FILE_MISSING: 'LOCAL_PACKAGE_FILE_MISSING',
  /** 备份包文件大小不符，无法核对完整性 */
  PACKAGE_FILE_SIZE_MISMATCH: 'LOCAL_PACKAGE_FILE_SIZE_MISMATCH',
  /** 备份包文件校验值不符，无法核对完整性 */
  PACKAGE_FILE_CHECKSUM_MISMATCH: 'LOCAL_PACKAGE_FILE_CHECKSUM_MISMATCH',
  /** 本地包已被清理，无需再处理 */
  PACKAGE_ALREADY_CLEANED: 'LOCAL_PACKAGE_ALREADY_CLEANED',
  /** 云回执缺失，云端副本不可证 */
  CLOUD_RECEIPT_MISSING: 'LOCAL_CLOUD_RECEIPT_MISSING',
  /** 云回执无法解析，云端副本不可证 */
  CLOUD_RECEIPT_UNPARSEABLE: 'LOCAL_CLOUD_RECEIPT_UNPARSEABLE',
  /** 云回执不是成功状态，云端副本不可证 */
  CLOUD_RECEIPT_NOT_SUCCESS: 'LOCAL_CLOUD_RECEIPT_NOT_SUCCESS',
  /** 云端副本未核验：本地包是唯一副本，保留不删 */
  CLOUD_COPY_UNVERIFIED: 'LOCAL_CLOUD_COPY_UNVERIFIED',
  /** 保留窗口未到 */
  RETENTION_NOT_EXPIRED: 'LOCAL_RETENTION_NOT_EXPIRED',
  /** 清理未执行（兜底原因） */
  CLEANUP_RETAINED: 'LOCAL_CLEANUP_RETAINED',
} as const;

export type LocalBackupFailureReason =
  (typeof LOCAL_BACKUP_FAILURE_REASON)[keyof typeof LOCAL_BACKUP_FAILURE_REASON];

/**
 * 受控原因码形态校验（用于**外部实现**返回的原因，如云接收端）。
 *
 * 为什么要校验外部返回：接收端实现不在本仓库内，若它回显自由文本
 * （含本机路径、凭据片段或他人正文），这些文本会经落库列与 GraphQL 字段外泄。
 * 因此落库前先校验形态：不合形态的一律降级为通用受控码，原始文本只进服务端日志。
 */
const CONTROLLED_REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** 是否为受控原因码形态 */
export function isControlledFailureReason(value: unknown): value is string {
  return typeof value === 'string' && CONTROLLED_REASON_PATTERN.test(value);
}

/**
 * 清理跳过原因（内部枚举）→ 对外受控原因码。
 *
 * 用途：把"为什么这一项没有被清理"逐项暴露给调用方，
 * 而不是只给一个总数——否则用户看不到"本地包因为是唯一副本而保留"。
 */
export function toLocalCleanupSkipReasonCode(reason: string): LocalBackupFailureReason {
  switch (reason) {
    case 'CLOUD_RECEIPT_MISSING':
      return LOCAL_BACKUP_FAILURE_REASON.CLOUD_RECEIPT_MISSING;
    case 'CLOUD_RECEIPT_UNPARSEABLE':
      return LOCAL_BACKUP_FAILURE_REASON.CLOUD_RECEIPT_UNPARSEABLE;
    case 'CLOUD_RECEIPT_NOT_SUCCESS':
      return LOCAL_BACKUP_FAILURE_REASON.CLOUD_RECEIPT_NOT_SUCCESS;
    case 'CLOUD_COPY_UNVERIFIED':
      return LOCAL_BACKUP_FAILURE_REASON.CLOUD_COPY_UNVERIFIED;
    case 'PACKAGE_ALREADY_CLEANED':
      return LOCAL_BACKUP_FAILURE_REASON.PACKAGE_ALREADY_CLEANED;
    case 'PACKAGE_REFERENCE_MISSING':
      return LOCAL_BACKUP_FAILURE_REASON.PACKAGE_REFERENCE_MISSING;
    case 'RETENTION_NOT_EXPIRED':
      return LOCAL_BACKUP_FAILURE_REASON.RETENTION_NOT_EXPIRED;
    default:
      return LOCAL_BACKUP_FAILURE_REASON.CLEANUP_RETAINED;
  }
}
