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
  /**
   * 单个包内文件的**上传大小上限**（字节）。
   *
   * 为什么必须设上限：备份包要整读进内存再以 multipart 部件送出，
   * 没有上限就等于"一个超大文件把 Worker 内存吃光"（进程崩溃比一次失败更糟）。
   * 超限时按受控原因码失败关闭，**不**上传。
   */
  maxUploadFileBytes: number;
  /**
   * 整个备份包的**上传大小上限**（字节）。
   *
   * 单件都合法不代表整体合法：多件累加同样会吃光内存。
   */
  maxUploadPackageBytes: number;
};

export const LOCAL_BACKUP_CLOUD_CONFIG = Symbol('LOCAL_BACKUP_CLOUD_CONFIG');

/**
 * 云备份调用的**默认值**（可由 env 覆盖）——**单一来源**。
 *
 * 此前这三份默认值在 `config.module.ts` 与 `local-backup-cloud.module.ts` 各写一份：
 * - 改一处不改另一处 ⇒ 上限与超时在两处口径不一致，
 *   而"读字节之前失败关闭"的大小闸门一旦两处不同，**大包会绕过内存闸门**；
 * - 且 module 层的 `?? DEFAULT_*` 分支在 config 已带默认值的前提下实际不可达。
 */
export const DEFAULT_LOCAL_BACKUP_CLOUD_TIMEOUT_MS = 30_000;
export const DEFAULT_LOCAL_BACKUP_CLOUD_MAX_UPLOAD_FILE_BYTES = 128 * 1024 * 1024;
export const DEFAULT_LOCAL_BACKUP_CLOUD_MAX_UPLOAD_PACKAGE_BYTES = 512 * 1024 * 1024;

/** 凭据与用途请求头名（云端按同一约定校验） */
export const CLOUD_AUTHORIZATION_HEADER = 'authorization';
export const CLOUD_PURPOSE_HEADER = 'x-cloud-purpose';
