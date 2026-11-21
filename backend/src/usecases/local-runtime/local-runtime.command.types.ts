// src/usecases/local-runtime/local-runtime.command.types.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { SyncConflictAction } from '@core/local-runtime/policy/sync-conflict-resolve.policy';
import type { SyncConflictSnapshot } from '@src/modules/lithography/sync.types';
import type {
  LocalBackupTriggerType,
  LocalUploadTaskStatus,
} from '@src/modules/lithography/local-runtime.types';

export type LocalRuntimeSettingsInput = {
  localSiteName?: string | null;
  autoUploadEnabled?: boolean;
  backupIntervalDays?: number;
};

export type GetLocalRuntimeSettingsCommand = {
  session: UsecaseSession;
};

export type GetLocalRuntimeStatusCommand = {
  session: UsecaseSession;
};

export type UpdateLocalRuntimeSettingsCommand = {
  session: UsecaseSession;
  settings: LocalRuntimeSettingsInput;
};

export type LocalRuntimePagination = {
  page: number;
  pageSize: number;
  withTotal?: boolean;
};

export type EnqueueLocalUploadCommand = {
  entityType: string;
  entityLocalId: number;
  entityVersion: string;
  idempotencyKey: string;
};

export type EnqueueLocalUploadResult = {
  taskId: number;
  status: LocalUploadTaskStatus;
  created: boolean;
};

export type LocalUploadTaskCommand = {
  taskId: number;
};

export type CompleteLocalUploadCommand = {
  taskId: number;
  remoteId: string | null;
  remoteReceipt: string | null;
};

export type FailLocalUploadCommand = {
  taskId: number;
  errorCode: string;
  errorMessage: string;
};

export type StartLocalBackupCommand = {
  triggerType: string;
  manifestPath?: string | null;
};

export type FinishLocalBackupCommand = {
  runId: number;
  status: string;
  manifestPath?: string | null;
  manifestChecksum?: string | null;
  byteSize?: number | null;
  attachmentCount?: number | null;
  schemaVersion?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type ListLocalUploadTasksCommand = {
  session: UsecaseSession;
  status?: string;
  pagination?: LocalRuntimePagination;
};

export type ListLocalBackupRunsCommand = {
  session: UsecaseSession;
  pagination?: LocalRuntimePagination;
};

export type LocalBackupTriggerTypeInput = LocalBackupTriggerType;

// ---- 任务09 S2：同步冲突读取与裁决（R066–R069）----

export type ListSyncConflictsCommand = {
  session: UsecaseSession;
  /** 只看待处理（冲突页默认入口） */
  statusOnlyPending?: boolean;
  pagination?: LocalRuntimePagination;
};

export type GetSyncConflictCommand = {
  session: UsecaseSession;
  conflictId: string;
};

export type ResolveSyncConflictCommand = {
  session: UsecaseSession;
  conflictId: string;
  action: SyncConflictAction;
};

/** 裁决结果视图：'existing' 表示重复请求返回既有事实，'later' 保持待处理 */
export type SyncConflictResolveOutcomeView = {
  outcome: 'existing' | 'later' | 'resolved';
  conflict: SyncConflictSnapshot | null;
};

// ---- 任务09 S2：本人同公司授权续期（R065，补验 S1.3）----

export type RenewMyLocalAuthorizationCommand = {
  session: UsecaseSession;
  /** 签名凭据材料；禁止包含密码/密钥/令牌原文键（core 策略校验） */
  signedClaims: unknown;
  /** 签名权限版本，>=1（对齐 DB CHECK） */
  permissionVersion: number;
};

export type RenewMyLocalAuthorizationResult = {
  renewedAuthorizationId: string;
};

// ---- 任务09 S2.3：记录包检查与处理结果（R071／R073）----

export type CheckRecordPackageCommand = {
  session: UsecaseSession;
  /** 包目录（U盘挂载点或本机目录），内含 manifest.json 与清单引用文件 */
  packagePath: string;
};

export type GetRecordPackageResultCommand = {
  session: UsecaseSession;
  packageId: string;
};

export type ExportRecordPackageCommand = {
  session: UsecaseSession;
  /** 导出目标目录（本机绝对路径；必须不存在或为空目录） */
  targetPath: string;
  /** 导出的公司数据区（一级管理员可指定任意公司，其余必须为本公司） */
  organizationId: number;
  resourceType: string;
  recordIds: number[];
};

// ---- 任务09 S3：备份记录、自动备份设置与手动备份触发 ----

export type ListLocalBackupRecordsCommand = {
  session: UsecaseSession;
  pagination?: LocalRuntimePagination;
};

export type GetLocalBackupRecordCommand = {
  session: UsecaseSession;
  backupId: string;
};

export type GetLocalBackupSettingsCommand = {
  session: UsecaseSession;
};

/** 恢复预检命令（管理员专属；工程师不开放） */
export type PrecheckLocalRestoreCommand = {
  session: UsecaseSession;
  /** 被恢复的备份资产 ID */
  backupId: string;
};

/**
 * 手动备份触发命令。
 *
 * - 二级管理员与工程师：目标公司只能是本公司（organizationId 省略或必须等于本公司）；
 * - 一级管理员：可指定任意公司；省略时取本机映射公司，未映射则失败关闭。
 */
export type StartManualLocalBackupCommand = {
  session: UsecaseSession;
  organizationId?: number | null;
};

/** 手动三阶段（生成→上云→清理）的阶段状态；未发生的阶段如实标记 */
export type LocalBackupManualPhaseStatus =
  'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'NOT_REQUIRED';

export type StartManualLocalBackupResult = {
  runId: number;
  organizationId: number;
  status: 'SUCCEEDED' | 'FAILED';
  backupId: string | null;
  manifestChecksum: string | null;
  byteSize: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** 上云阶段真实状态；云接收端未接入时保持 PENDING */
  uploadStatus: LocalBackupManualPhaseStatus;
  /** 清理阶段真实状态；无完整云回执时为 NOT_EXECUTED */
  cleanupStatus: LocalBackupManualPhaseStatus;
};
