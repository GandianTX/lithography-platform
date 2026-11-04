// src/usecases/local-runtime/local-runtime.input.normalize.ts
// 本地运行数据输入归一化：设置、上传意图/回执/失败、备份触发与结束清单。

import { DomainError, LOCAL_RUNTIME_ERROR } from '@core/common/errors/domain-error';
import type {
  LocalBackupRunFinishData,
  LocalBackupRunStatus,
  LocalBackupTriggerType,
  LocalEntityType,
  LocalUploadTaskStatus,
} from '@src/modules/lithography/local-runtime.types';
import type {
  FailLocalUploadCommand,
  FinishLocalBackupCommand,
  LocalRuntimePagination,
  LocalRuntimeSettingsInput,
} from './local-runtime.command.types';

const ENTITY_TYPES: readonly LocalEntityType[] = [
  'REPORT_VERSION',
  'ATTACHMENT',
  'BACKUP_MANIFEST',
];
const TRIGGER_TYPES: readonly LocalBackupTriggerType[] = ['SCHEDULED', 'MANUAL', 'USB_EXPORT'];
const FINISH_STATUSES: readonly LocalBackupRunStatus[] = ['SUCCEEDED', 'FAILED', 'INTERRUPTED'];
const UPLOAD_STATUSES: readonly LocalUploadTaskStatus[] = [
  'PENDING',
  'UPLOADING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
];
const SITE_NAME_MAX = 100;
const ENTITY_VERSION_MAX = 64;
const IDEMPOTENCY_KEY_MAX = 191;
const REMOTE_ID_MAX = 128;
const REMOTE_RECEIPT_MAX = 512;
const ERROR_CODE_MAX = 64;
const ERROR_MESSAGE_MAX = 1000;
const MANIFEST_PATH_MAX = 512;
const SMALLINT_UNSIGNED_MAX = 65535;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export type NormalizedSettingsPatch = {
  localSiteName?: string | null;
  autoUploadEnabled?: boolean;
  backupIntervalDays?: number;
};

export type NormalizedUploadIntent = {
  entityType: LocalEntityType;
  entityLocalId: number;
  entityVersion: string;
  idempotencyKey: string;
};

export function normalizeSettingsPatch(input: LocalRuntimeSettingsInput): NormalizedSettingsPatch {
  const patch: NormalizedSettingsPatch = {};
  if (input.localSiteName !== undefined) {
    patch.localSiteName = normalizeOptionalText(input.localSiteName, SITE_NAME_MAX, '现场名称');
  }
  if (input.autoUploadEnabled !== undefined) {
    if (typeof input.autoUploadEnabled !== 'boolean') {
      throw invalid('自动上传开关必须为布尔值');
    }
    patch.autoUploadEnabled = input.autoUploadEnabled;
  }
  if (input.backupIntervalDays !== undefined) {
    const days = input.backupIntervalDays;
    if (!Number.isInteger(days) || days < 1 || days > SMALLINT_UNSIGNED_MAX) {
      throw invalid(`备份间隔必须在 1-${SMALLINT_UNSIGNED_MAX} 天之间`, {
        backupIntervalDays: days,
      });
    }
    patch.backupIntervalDays = days;
  }
  return patch;
}

export function normalizeUploadIntent(command: {
  entityType: string;
  entityLocalId: number;
  entityVersion: string;
  idempotencyKey: string;
}): NormalizedUploadIntent {
  if (!ENTITY_TYPES.includes(command.entityType as LocalEntityType)) {
    throw invalid('上传实体类型无效', { entityType: command.entityType });
  }
  if (!Number.isInteger(command.entityLocalId) || command.entityLocalId <= 0) {
    throw invalid('本地实体 ID 必须为正整数', { entityLocalId: command.entityLocalId });
  }
  const entityVersion = requireText(command.entityVersion, ENTITY_VERSION_MAX, '实体版本');
  const idempotencyKey = requireText(command.idempotencyKey, IDEMPOTENCY_KEY_MAX, '幂等键');
  return {
    entityType: command.entityType as LocalEntityType,
    entityLocalId: command.entityLocalId,
    entityVersion,
    idempotencyKey,
  };
}

export function normalizeTaskId(taskId: number): number {
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw invalid('上传任务 ID 无效', { taskId });
  }
  return taskId;
}

export function normalizeRunId(runId: number): number {
  if (!Number.isInteger(runId) || runId <= 0) {
    throw invalid('备份运行 ID 无效', { runId });
  }
  return runId;
}

export function normalizeUploadReceipt(remoteId: string | null): string | null {
  return normalizeOptionalText(remoteId, REMOTE_ID_MAX, '云端标识');
}

export function normalizeUploadReceiptText(remoteReceipt: string | null): string | null {
  return normalizeOptionalText(remoteReceipt, REMOTE_RECEIPT_MAX, '上传回执');
}

export function normalizeUploadFailure(command: FailLocalUploadCommand): {
  errorCode: string;
  errorMessage: string;
} {
  return {
    errorCode: requireText(command.errorCode, ERROR_CODE_MAX, '错误码'),
    errorMessage: requireText(command.errorMessage, ERROR_MESSAGE_MAX, '错误说明'),
  };
}

export function normalizeUploadStatus(
  value: string | undefined,
): LocalUploadTaskStatus | undefined {
  if (value === undefined) return undefined;
  if (!UPLOAD_STATUSES.includes(value as LocalUploadTaskStatus)) {
    throw invalid('上传任务状态无效', { status: value });
  }
  return value as LocalUploadTaskStatus;
}

export function normalizeManifestPath(value: string | null | undefined): string | null {
  return normalizeOptionalText(value ?? null, MANIFEST_PATH_MAX, '清单路径');
}

export function normalizeBackupTrigger(value: string): LocalBackupTriggerType {
  if (!TRIGGER_TYPES.includes(value as LocalBackupTriggerType)) {
    throw invalid('备份触发类型无效', { triggerType: value });
  }
  return value as LocalBackupTriggerType;
}

/**
 * 归一化备份结束事实：结束时间由服务端事件时间写入，不接受客户端自报。
 * 成功必须具备清单校验值；失败必须具备错误码与说明。
 * 清单路径缺省时不产出覆盖值（由服务层保留开始时的路径）。
 */
export function normalizeBackupFinish(
  command: FinishLocalBackupCommand,
  finishedAt: Date,
): LocalBackupRunFinishData {
  const status = assertFinishStatus(command.status);
  // 只有调用方显式给出清单路径时才产出覆盖值；缺省保留开始时的路径，避免被清空
  const manifestPath =
    command.manifestPath === undefined ? undefined : normalizeManifestPath(command.manifestPath);
  const manifestChecksum = normalizeChecksum(command.manifestChecksum ?? null);
  const errorCode = normalizeOptionalText(command.errorCode ?? null, ERROR_CODE_MAX, '错误码');
  const errorMessage = normalizeOptionalText(
    command.errorMessage ?? null,
    ERROR_MESSAGE_MAX,
    '错误说明',
  );
  const byteSize = normalizeOptionalNonNegativeInteger(command.byteSize ?? null, '备份字节数');
  const attachmentCount = normalizeOptionalNonNegativeInteger(
    command.attachmentCount ?? null,
    '附件条目数',
  );
  const schemaVersion = normalizeOptionalNonNegativeInteger(
    command.schemaVersion ?? null,
    '结构版本',
  );
  assertFinishRequirements(status, manifestChecksum, errorCode, errorMessage);

  return {
    status,
    finishedAt,
    manifestPath,
    manifestChecksum,
    byteSize,
    attachmentCount,
    schemaVersion,
    errorCode: status === 'SUCCEEDED' ? null : errorCode,
    errorMessage: status === 'SUCCEEDED' ? null : errorMessage,
  };
}

function assertFinishStatus(value: string): LocalBackupRunFinishData['status'] {
  if (!FINISH_STATUSES.includes(value as LocalBackupRunStatus)) {
    throw invalid('备份结束状态无效', { status: value });
  }
  return value as LocalBackupRunFinishData['status'];
}

function assertFinishRequirements(
  status: LocalBackupRunFinishData['status'],
  manifestChecksum: string | null,
  errorCode: string | null,
  errorMessage: string | null,
): void {
  if (status === 'SUCCEEDED' && manifestChecksum === null) {
    throw invalid('备份成功时必须提供清单校验值');
  }
  if (status === 'FAILED' && (errorCode === null || errorMessage === null)) {
    throw invalid('备份失败时必须提供错误码与错误说明');
  }
}

export function normalizePagination(
  pagination: LocalRuntimePagination | undefined,
): Required<LocalRuntimePagination> {
  const page = pagination?.page ?? 1;
  const pageSize = pagination?.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(page) || page < 1) {
    throw invalid('页码必须为正整数', { page });
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw invalid(`每页条数必须在 1-${MAX_PAGE_SIZE} 之间`, { pageSize });
  }
  return { page, pageSize, withTotal: pagination?.withTotal ?? true };
}

function normalizeChecksum(value: string | null): string | null {
  const normalized = normalizeOptionalText(value, 64, '清单校验值');
  if (normalized === null) return null;
  if (!/^[0-9a-f]{64}$/i.test(normalized)) {
    throw invalid('清单校验值必须为 64 位十六进制');
  }
  return normalized.toLowerCase();
}

function normalizeOptionalNonNegativeInteger(
  value: number | null,
  fieldName: string,
): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw invalid(`${fieldName}必须为非负整数`, { [fieldName]: value });
  }
  return value;
}

function normalizeOptionalText(
  value: string | null,
  maxLength: number,
  fieldName: string,
): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    throw invalid(`${fieldName}不能超过 ${maxLength} 个字符`, {
      fieldName,
      length: trimmed.length,
    });
  }
  return trimmed;
}

function requireText(value: string, maxLength: number, fieldName: string): string {
  const normalized = normalizeOptionalText(value, maxLength, fieldName);
  if (normalized === null) {
    throw invalid(`${fieldName}不能为空`, { fieldName });
  }
  return normalized;
}

function invalid(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError(LOCAL_RUNTIME_ERROR.INVALID_PARAMS, message, details);
}
