// src/usecases/common/ports/protected-backup.contract.ts

/**
 * 受保护备份执行契约（任务 09 S3.1，D-7）。
 * 配置读取归 infrastructure wiring；服务层只消费稳定 contract type，
 * 密钥材料不进日志、不经 API 返回、不落包。
 */
export const LOCAL_BACKUP_PROTECTION = Symbol('LOCAL_BACKUP_PROTECTION');

/** 保护密钥材料：64 位十六进制密钥与密钥标识（密钥标识写入 backup_asset.encryption_key_id） */
export type ProtectedBackupMaterial = { keyHex: string; keyId: string };

export const LOCAL_BACKUP_STORAGE = Symbol('LOCAL_BACKUP_STORAGE');

/** 备份包落点配置：必须与业务原件目录物理分离（D-7） */
export type LocalBackupStorageConfig = { baseDir: string };
