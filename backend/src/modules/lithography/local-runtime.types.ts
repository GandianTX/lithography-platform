// src/modules/lithography/local-runtime.types.ts
// 本地运行数据（安装身份/设置、上传任务、备份清单）的模块级契约。
// 只承载部署身份、上传意图/回执与备份清单，不复制云端业务主键。

export type LocalEntityType = 'REPORT_VERSION' | 'ATTACHMENT' | 'BACKUP_MANIFEST';
export type LocalUploadTaskStatus = 'PENDING' | 'UPLOADING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type LocalBackupTriggerType = 'SCHEDULED' | 'MANUAL' | 'USB_EXPORT';
export type LocalBackupRunStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';

export type LocalInstallationSnapshot = {
  id: number;
  installationId: string;
  organizationId: number | null;
  organizationCodeSnapshot: string | null;
  localSiteName: string | null;
  autoUploadEnabled: boolean;
  backupIntervalDays: number;
  lastBackupCompletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LocalInstallationSettingsWriteData = {
  localSiteName: string | null;
  autoUploadEnabled: boolean;
  backupIntervalDays: number;
};

export type LocalUploadTaskSnapshot = {
  id: number;
  installationId: string;
  entityType: LocalEntityType;
  entityLocalId: number;
  entityVersion: string;
  idempotencyKey: string;
  status: LocalUploadTaskStatus;
  attemptCount: number;
  lastAttemptAt: Date | null;
  remoteId: string | null;
  remoteReceipt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LocalUploadTaskInsertData = {
  installationId: string;
  entityType: LocalEntityType;
  entityLocalId: number;
  entityVersion: string;
  idempotencyKey: string;
};

export type LocalUploadSuccessData = {
  remoteId: string | null;
  remoteReceipt: string | null;
};

export type LocalUploadFailureData = {
  errorCode: string;
  errorMessage: string;
};

export type LocalBackupRunSnapshot = {
  id: number;
  installationId: string;
  triggerType: LocalBackupTriggerType;
  status: LocalBackupRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  manifestPath: string | null;
  manifestChecksum: string | null;
  byteSize: number | null;
  attachmentCount: number | null;
  schemaVersion: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LocalBackupRunStartData = {
  installationId: string;
  triggerType: LocalBackupTriggerType;
  startedAt: Date;
  manifestPath: string | null;
};

export type LocalBackupRunFinishData = {
  status: Exclude<LocalBackupRunStatus, 'RUNNING'>;
  finishedAt: Date;
  /**
   * 清单路径：仅当调用方显式提供时才覆盖。
   * undefined 表示本轮未产出清单（如失败/中断），不得把开始时的路径清空。
   */
  manifestPath?: string | null;
  manifestChecksum: string | null;
  byteSize: number | null;
  attachmentCount: number | null;
  schemaVersion: number | null;
  errorCode: string | null;
  errorMessage: string | null;
};
