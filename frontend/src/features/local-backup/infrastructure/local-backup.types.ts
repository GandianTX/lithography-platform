// src/features/local-backup/infrastructure/local-backup.types.ts

/** 备份触发方式（与后端枚举同口径） */
export type LocalBackupTriggerType = 'AUTO' | 'MANUAL' | 'RETRY' | 'SCHEDULED' | 'USB_EXPORT';

/** 云端状态 */
export type LocalBackupCloudStatus = 'FAILED' | 'PENDING' | 'SUCCEEDED' | 'UPLOADING';

/** 本地包状态 */
export type LocalBackupLocalStatus = 'CLEANED' | 'CLEANING' | 'FAILED' | 'PENDING';

/** 备份运行状态 */
export type LocalBackupRunStatus = 'FAILED' | 'INTERRUPTED' | 'RUNNING' | 'SUCCEEDED';

/** 备份记录行 */
export type LocalBackupRecord = {
  backupId: string;
  organizationId: number;
  runId: number | null;
  installationId: string | null;
  triggerType: LocalBackupTriggerType | null;
  runStatus: LocalBackupRunStatus | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  byteSize: number | null;
  localStatus: LocalBackupLocalStatus;
  localPackageRetained: boolean;
  cloudStatus: LocalBackupCloudStatus;
  cloudReceiptPresent: boolean;
  manifestChecksum: string | null;
  verifiedAt: string | null;
  retentionUntil: string | null;
  failureReason: string | null;
  localCleanupError: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  deletedAt: string | null;
};

/** 一致性范围快照条目 */
export type LocalBackupScopeEntry = {
  table: string;
  rowCount: number;
  lastUpdatedAt: string | null;
};

/** 备份记录详情 */
export type LocalBackupRecordDetail = {
  record: LocalBackupRecord;
  schemaVersion: number | null;
  protectionKeyId: string | null;
  fileCount: number | null;
  originalCount: number | null;
  scope: LocalBackupScopeEntry[];
  manifestReadable: boolean;
};

/** 备份记录分页结果 */
export type LocalBackupRecordPage = {
  items: LocalBackupRecord[];
  total: number | null;
  page: number;
  pageSize: number;
};

/** 自动备份设置 */
export type LocalBackupSetting = {
  organizationId: number;
  installationId: string;
  backupEnabled: boolean;
  backupIntervalHours: number;
  nextBackupAt: string | null;
  lastAutoSuccessAt: string | null;
  lastAutoFailureAt: string | null;
  failureReason: string | null;
  autoUploadEnabled: boolean;
  planIntervalHours: number;
  retentionDays: number;
  lastRunStatus: LocalBackupRunStatus | null;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastAssetCloudStatus: LocalBackupCloudStatus | null;
  lastAssetLocalStatus: LocalBackupLocalStatus | null;
};

/** 手动备份触发结果 */
export type StartManualLocalBackupResult = {
  runId: number;
  organizationId: number;
  status: 'FAILED' | 'SUCCEEDED';
  backupId: string | null;
  manifestChecksum: string | null;
  byteSize: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  uploadStatus: 'FAILED' | 'NOT_REQUIRED' | 'PENDING' | 'RUNNING' | 'SUCCEEDED';
  cleanupStatus: 'FAILED' | 'NOT_REQUIRED' | 'PENDING' | 'RUNNING' | 'SUCCEEDED';
};

/** 恢复预检发现项 */
export type LocalRestoreCheckFinding = {
  code: string;
  message: string;
};

/** 恢复预检结果 */
export type LocalRestorePrecheckResult = {
  restoreId: string;
  outcome: 'FAILED' | 'PASSED';
  checkedAt: string;
  targetBackupId: string;
  targetOrganizationId: number;
  targetInstallationId: string | null;
  manifestChecksum: string | null;
  packageReadable: boolean;
  fileCount: number | null;
  originalCount: number | null;
  verifiedFileCount: number;
  protectionBackupId: string | null;
  protectionCreated: boolean;
  findings: LocalRestoreCheckFinding[];
};

/** 恢复执行能力状态 */
export type LocalRestoreCapability = {
  executionAvailable: boolean;
  reason: string;
};
