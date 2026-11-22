// src/usecases/common/ports/local-backup-cloud-provider.contract.ts

/**
 * 云端备份包的**受控读取端口**（任务 09 S4）。
 *
 * 目标（S4 第 3 条）：实现受授权的备份元数据与包下载——
 * **本地已清理但云包仍可用**时，仍能按授权查找并取回云端副本。
 *
 * 纪律：
 * - **下载权限 ≠ 恢复权限**：本端口只提供"受授权的字节流"，不提供恢复语义；
 *   恢复仍需管理员准入 ＋ 恢复预检 ＋ 保护副本（见恢复链）；
 * - **不暴露密钥**：清单与下载结果只给受控元数据（包标识、摘要、大小、时间），
 *   凭据与存储引用不出本端口；
 * - **隐藏他人草稿**：范围由调用方的**可信 session 公司**决定，实现方不得返回
 *   超出该范围的包；
 * - 生产云服务尚未接入（R-02）：本端口**未注册**时，调用方按受控原因码
 *   "云服务未接入"失败关闭，不伪造可用包。
 */

import type { UsecaseSession } from '@app-types/auth/session.types';

/** 端口令牌（DI 注入用） */
export const LOCAL_BACKUP_CLOUD_PROVIDER = 'LOCAL_BACKUP_CLOUD_PROVIDER';

/** 云端备份包的受控元数据（不含密钥与存储引用） */
export type LocalBackupCloudPackageSummary = {
  /** 云端包标识（用于下载） */
  packageId: string;
  /** 归属公司（数据为准） */
  organizationId: number;
  /** 本机备份标识（可为空：云端包可能来自更早的本机） */
  backupId: string | null;
  /** 生成时间 */
  createdAt: string | null;
  /** 字节数 */
  byteSize: number | null;
  /** 内容摘要 */
  checksumSha256: string | null;
};

/** 云端备份包下载结果 */
export type LocalBackupCloudPackageDownload = {
  /** 建议文件名 */
  fileName: string;
  /** 包字节 */
  content: Buffer;
};

/** 云端备份包读取端口 */
export interface LocalBackupCloudProvider {
  /** 受授权的云端包清单（范围＝调用方给定的公司） */
  listPackages(
    session: UsecaseSession,
    query: { organizationId: number },
  ): Promise<LocalBackupCloudPackageSummary[]>;
  /** 下载指定云端包（**只给字节，不触发恢复**） */
  downloadPackage(
    session: UsecaseSession,
    key: { organizationId: number; packageId: string },
  ): Promise<LocalBackupCloudPackageDownload>;
}
