// src/usecases/local-runtime/local-runtime.command.types.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
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
