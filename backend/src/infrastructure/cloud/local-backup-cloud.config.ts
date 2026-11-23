// src/infrastructure/cloud/local-backup-cloud.config.ts

/**
 * 云备份服务的**服务端配置**（任务 09 S3.1／S4）。
 *
 * 纪律：
 * - **不硬编码地址与凭据**：全部来自环境变量（见 `config.module.ts` 的 `localRuntimeConfig`）；
 * - 缺地址或缺凭据 ⇒ `baseUrl`／`credential` 为 null ⇒ **不注册**云端口，
 *   调用方按"云服务未接入"失败关闭（不伪造成功、不伪造回执、不伪造可用包）；
 * - 凭据只在本模块内注入到 HTTP 客户端，**不进日志、不进包、不经 API 返回**；
 * - 用途固定为 `CLOUD_BACKUP`：上云不得拿业务同步授权充数（见 `local-credential-purpose.policy`）。
 */
export type LocalBackupCloudConfig = {
  /** 云服务根地址（形如 https://cloud.example.com/api）；未配置为 null */
  baseUrl: string | null;
  /** 本机云备份凭据（设备／公司／用途三维）；未配置为 null */
  credential: string | null;
  /** 请求超时（毫秒） */
  timeoutMs: number;
};

export const LOCAL_BACKUP_CLOUD_CONFIG = Symbol('LOCAL_BACKUP_CLOUD_CONFIG');

/** 凭据与用途请求头名（云端按同一约定校验） */
export const CLOUD_AUTHORIZATION_HEADER = 'authorization';
export const CLOUD_PURPOSE_HEADER = 'x-cloud-purpose';
