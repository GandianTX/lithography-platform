// src/features/local-runtime/infrastructure/local-runtime.types.ts

/**
 * 本地运行数据前端契约（任务 09 S1）。
 *
 * 与后端 `LocalRuntimeStatus` GraphQL 类型一一对应；日期统一为 ISO 字符串，
 * 由 UI 层按语言格式化。不引入任何后端内部字段（密钥、路径解析结果）。
 */

export type LocalRuntimeViewerRole = 'ADMIN_LEVEL_1' | 'ADMIN_LEVEL_2' | 'ENGINEER';

export type LocalRuntimeServiceStatus = {
  apiStatus: string;
  databaseStatus: string;
  taskFactSource: string;
  taskRecovery: string;
};

export type LocalRuntimeStorageStatus = {
  businessFileDirectory: string;
  businessFileDirectoryWritable: boolean;
  backupDirectory: string;
  backupDirectoryWritable: boolean;
};

export type LocalRuntimeTaskStatus = {
  pendingUploadCount: number;
  uploadingUploadCount: number;
  failedUploadCount: number;
  succeededUploadCount: number;
  runningBackupCount: number;
  lastBackupStartedAt: string | null;
  lastBackupFinishedAt: string | null;
};

export type LocalRuntimeCompanySetting = {
  organizationId: number;
  backupEnabled: boolean;
  backupIntervalHours: number;
  nextBackupAt: string | null;
  lastAutoSuccessAt: string | null;
  lastAutoFailureAt: string | null;
  failureReason: string | null;
  autoUploadEnabled: boolean;
  initializedAt: string;
};

export type LocalRuntimeAuthorizationSummary = {
  organizationId: number;
  activeCount: number;
  revokedCount: number;
  lastVerifiedAt: string | null;
  /** BUSINESS_SYNC：业务同步凭据；自动备份凭据不在此表 */
  credentialPurpose: string;
};

export type LocalRuntimeStatus = {
  installationId: string;
  localSiteName: string | null;
  mappedOrganizationId: number | null;
  mappedOrganizationCode: string | null;
  viewerRole: LocalRuntimeViewerRole;
  /** 一级管理员为 null，表示全局授权范围而非"无公司" */
  scopeOrganizationId: number | null;
  service: LocalRuntimeServiceStatus;
  storage: LocalRuntimeStorageStatus;
  /**
   * 全设备口径任务计数。仅一级管理员返回；
   * 二级管理员与工程师为 null（任务表无公司列，不跨公司暴露数量）
   */
  tasks: LocalRuntimeTaskStatus | null;
  companies: LocalRuntimeCompanySetting[];
  authorizations: LocalRuntimeAuthorizationSummary[];
  generatedAt: string;
};
