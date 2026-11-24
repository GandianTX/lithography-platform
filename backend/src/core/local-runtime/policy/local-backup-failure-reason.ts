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
  /** 云端备份包服务未接入（R-02）：元数据与下载一律失败关闭，不伪造可用云包 */
  CLOUD_PACKAGES_UNAVAILABLE: 'LOCAL_CLOUD_PACKAGES_UNAVAILABLE',
  /** 云端备份包预检：云端副本不可得 */
  CLOUD_PACKAGE_UNAVAILABLE: 'LOCAL_CLOUD_PACKAGE_UNAVAILABLE',
  /** 云端副本摘要与本机登记不一致 */
  CLOUD_PACKAGE_DIGEST_MISMATCH: 'LOCAL_CLOUD_PACKAGE_DIGEST_MISMATCH',
  /** 云端副本字节数与本机登记不一致 */
  CLOUD_PACKAGE_SIZE_MISMATCH: 'LOCAL_CLOUD_PACKAGE_SIZE_MISMATCH',
  /** 云端副本的包格式版本本机不支持 */
  CLOUD_PACKAGE_SCHEMA_UNSUPPORTED: 'LOCAL_CLOUD_PACKAGE_SCHEMA_UNSUPPORTED',
  /** 云端副本来源设备与本机不一致（异机副本不得用于本机恢复） */
  CLOUD_PACKAGE_DEVICE_MISMATCH: 'LOCAL_CLOUD_PACKAGE_DEVICE_MISMATCH',
  /** 云端副本归属公司与本机目标公司不一致 */
  CLOUD_PACKAGE_COMPANY_MISMATCH: 'LOCAL_CLOUD_PACKAGE_COMPANY_MISMATCH',
  /** 云端上传失败（底层原因只进服务端日志） */
  UPLOAD_FAILED: 'LOCAL_UPLOAD_FAILED',
  /** 上传过程被进程中断，将按退避重试同一备份包 */
  UPLOAD_INTERRUPTED: 'LOCAL_UPLOAD_INTERRUPTED',
  /** 备份包生成失败（底层原因只进服务端日志） */
  BACKUP_GENERATION_FAILED: 'LOCAL_BACKUP_GENERATION_FAILED',
  /** 保护副本生成失败（底层原因只进服务端日志） */
  PROTECTION_COPY_FAILED: 'LOCAL_PROTECTION_COPY_FAILED',
  /** 恢复写入失败（底层原因含约束名／SQL 片段，只进服务端日志） */
  RESTORE_WRITE_FAILED: 'LOCAL_RESTORE_WRITE_FAILED',
  /** 按保护副本回滚失败（底层原因只进服务端日志） */
  RESTORE_ROLLBACK_FAILED: 'LOCAL_RESTORE_ROLLBACK_FAILED',
  /** 保护副本不可读（包目录缺失／清单不可读） */
  RESTORE_PROTECTION_UNREADABLE: 'LOCAL_RESTORE_PROTECTION_UNREADABLE',
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
  /** 保留窗口未到 */
  RETENTION_NOT_EXPIRED: 'LOCAL_RETENTION_NOT_EXPIRED',
  /** 清理未执行（兜底原因） */
  CLEANUP_RETAINED: 'LOCAL_CLEANUP_RETAINED',
  /** 恢复预检：备份包不是本机产生的，不能在本机恢复 */
  RESTORE_TARGET_INSTALLATION_MISMATCH: 'LOCAL_RESTORE_TARGET_INSTALLATION_MISMATCH',
  /** 恢复预检：备份包不属于当前有权公司 */
  RESTORE_TARGET_ORGANIZATION_MISMATCH: 'LOCAL_RESTORE_TARGET_ORGANIZATION_MISMATCH',
  /** 恢复预检：本机已无该备份包，需要先从云端取得可用副本 */
  RESTORE_LOCAL_PACKAGE_MISSING: 'LOCAL_RESTORE_LOCAL_PACKAGE_MISSING',
  /** 恢复预检：备份清单登记了原件，但包内没有对应字节（恢复必然失败） */
  RESTORE_ORIGINAL_BYTES_MISSING: 'LOCAL_RESTORE_ORIGINAL_BYTES_MISSING',
} as const;

export type LocalBackupFailureReason =
  (typeof LOCAL_BACKUP_FAILURE_REASON)[keyof typeof LOCAL_BACKUP_FAILURE_REASON];

/**
 * 恢复**执行阶段**的受控原因码（对外只给码，前端按码映射文案）。
 *
 * 为什么单列一份：这些码此前是 `local-restore-execution.service.ts` 里的
 * **裸字符串字面量**（`RESTORE_EXECUTION_FAILED` 等），没有唯一清单 ⇒
 * - 前端码表靠人工对齐，漏一个就显示"原因未登记"；
 * - 后端自己拼错一个字也没有任何编译期或测试期的兜底。
 */
export const LOCAL_RESTORE_EXECUTION_REASON_CODES = {
  /** 恢复运行不存在 */
  RUN_NOT_FOUND: 'RESTORE_RUN_NOT_FOUND',
  /** 恢复未被受理或已结束 */
  NOT_ACCEPTED: 'RESTORE_NOT_ACCEPTED',
  /** 恢复预检未通过 */
  CHECK_NOT_PASSED: 'RESTORE_CHECK_NOT_PASSED',
  /** 本机安装身份未初始化 */
  INSTALLATION_MISSING: 'RESTORE_INSTALLATION_MISSING',
  /** 恢复后的数据核验未通过 */
  VERIFY_FAILED: 'RESTORE_VERIFY_FAILED',
  /** 恢复执行失败 */
  EXECUTION_FAILED: 'RESTORE_EXECUTION_FAILED',
  /** 同一次恢复的并发执行被拒 */
  EXECUTION_ALREADY_RUNNING: 'RESTORE_EXECUTION_ALREADY_RUNNING',
  /** 恢复范围被其它恢复占用 */
  SCOPE_OCCUPIED: 'RESTORE_SCOPE_OCCUPIED',
  /**
   * 该恢复运行**已是终态**（成功／失败／中断）⇒ 不得再次执行旧备份。
   *
   * 口径（任务 09 独立验收 P1-2）：取得执行权之后必须重新读取最新运行事实，
   * 终态行**不再被占用** ⇒ 延迟到达的重复请求如实受控拒绝（零写入）。
   */
  ALREADY_TERMINAL: 'RESTORE_ALREADY_TERMINAL',
  /** 执行人不属于该恢复目标公司的授权范围（跨公司执行被拒） */
  ORGANIZATION_NOT_ALLOWED: 'RESTORE_ORGANIZATION_NOT_ALLOWED',
  /** 该恢复的目标安装不是本机（异机执行被拒） */
  INSTALLATION_MISMATCH: 'RESTORE_INSTALLATION_MISMATCH',
} as const;

export type LocalRestoreExecutionReasonCode =
  (typeof LOCAL_RESTORE_EXECUTION_REASON_CODES)[keyof typeof LOCAL_RESTORE_EXECUTION_REASON_CODES];

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
