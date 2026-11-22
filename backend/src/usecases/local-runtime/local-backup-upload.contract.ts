// src/usecases/local-runtime/local-backup-upload.contract.ts
// 自动上云接收端契约（任务 09 S3.2）。
//
// 边界归属：是否把本机备份包上云属本任务业务决策，故契约由 usecases 层声明，
// infrastructure 只提供实现。契约只描述"上传一个已生成的本机包并取回完整回执"，
// 不描述任何云端内部实现，也不携带本机密钥材料。

export const LOCAL_BACKUP_UPLOADER = Symbol('LOCAL_BACKUP_UPLOADER');

export type LocalBackupUploadRequest = {
  /** 备份资产 ID（backup_asset.backup_id） */
  backupId: string;
  /** 公司数据区 */
  organizationId: number;
  /** 本机安装标识 */
  installationId: string;
  /** 本机包目录（已含 manifest.json／payload.enc／files/） */
  packagePath: string;
  /** 清单 SHA-256；云端据此校验同一份包 */
  manifestChecksum: string;
  /** 包总字节数 */
  byteSize: number;
};

export type LocalBackupUploadSuccess = {
  status: 'SUCCEEDED';
  /** 云端对象引用 */
  cloudReference: string;
  /** 完整回执原文（云端确认收到并校验通过的事实） */
  receipt: string;
};

export type LocalBackupUploadFailure = {
  status: 'FAILED';
  /**
   * 失败原因（**受控原因码**）：形如 `CLOUD_TIMEOUT` 的大写下划线标识。
   * 不得回显自由文本、本机绝对路径或凭据片段——执行层会校验形态，
   * 不合形态的一律降级为通用受控码，原始文本只进服务端日志。
   */
  reason: string;
  /** 失败错误码（可展示，不含凭据） */
  code: string;
};

export type LocalBackupUploadResult = LocalBackupUploadSuccess | LocalBackupUploadFailure;

export type LocalBackupUploader = {
  upload(request: LocalBackupUploadRequest): Promise<LocalBackupUploadResult>;
};
