// src/usecases/local-runtime/local-runtime.input.normalize.ts
// 本地运行数据输入归一化：设置、上传意图/回执/失败、备份触发与结束清单。

import {
  DomainError,
  LOCAL_RUNTIME_ERROR,
  RECORD_PACKAGE_ERROR,
} from '@core/common/errors/domain-error';
import type {
  LocalBackupRunFinishData,
  LocalBackupRunStatus,
  LocalBackupTriggerType,
  LocalEntityType,
  LocalUploadTaskKind,
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
// 用户可发起的触发类型仅旧三值；AUTO/RETRY 为系统触发，只允许服务端写入，
// 不接受客户端输入（OI-01 读取层映射语义仍待裁决，此处不放宽输入边界）。
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
const RECORD_UUID_MAX = 36;
const REMOTE_ID_MAX = 128;
const REMOTE_RECEIPT_MAX = 512;
const ERROR_CODE_MAX = 64;
const ERROR_MESSAGE_MAX = 1000;
const MANIFEST_PATH_MAX = 512;
const BACKUP_ID_MAX = 36;
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
  /** 跨端稳定业务编号；备份类任务为 null */
  recordUuid: string | null;
  /** 业务版本；不可核验时为 null */
  sourceVersion: number | null;
  /** 正文与原件清单 SHA-256；缺失时为 null */
  manifestChecksum: string | null;
  /** 任务种类（BUSINESS_SYNC／BACKUP_UPLOAD） */
  taskKind: LocalUploadTaskKind;
  /** 公司数据区 */
  organizationId: number | null;
  /** 原账号（授权主体）账号ID */
  accountId: number | null;
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
  recordUuid?: string | null;
  sourceVersion?: number | null;
  manifestChecksum?: string | null;
  taskKind?: string | null;
  organizationId?: number | null;
  accountId?: number | null;
}): NormalizedUploadIntent {
  if (!ENTITY_TYPES.includes(command.entityType as LocalEntityType)) {
    throw invalid('上传实体类型无效', { entityType: command.entityType });
  }
  if (!Number.isInteger(command.entityLocalId) || command.entityLocalId <= 0) {
    throw invalid('本地实体 ID 必须为正整数', { entityLocalId: command.entityLocalId });
  }
  const entityVersion = requireText(command.entityVersion, ENTITY_VERSION_MAX, '实体版本');
  const idempotencyKey = requireText(command.idempotencyKey, IDEMPOTENCY_KEY_MAX, '幂等键');

  const entityType = command.entityType as LocalEntityType;
  const taskKind = normalizeUploadTaskKind(command.taskKind, entityType);
  const identity = normalizeBusinessSyncIdentity(command, taskKind);

  return {
    entityType,
    entityLocalId: command.entityLocalId,
    entityVersion,
    idempotencyKey,
    recordUuid: identity.recordUuid,
    sourceVersion: identity.sourceVersion,
    manifestChecksum: identity.manifestChecksum,
    taskKind,
    organizationId: identity.organizationId,
    accountId: identity.accountId,
  };
}

/** 业务同步身份事实（稳定键、版本、摘要、公司、原账号） */
type BusinessSyncIdentity = {
  recordUuid: string | null;
  sourceVersion: number | null;
  manifestChecksum: string | null;
  organizationId: number | null;
  accountId: number | null;
};

/**
 * 归一业务同步身份事实。
 *
 * 业务同步任务必须带齐五项：缺任一项都会让读侧判"不可核验"，
 * 任务也会因无法核对公司与原账号而无法派发。此处失败关闭，不做静默降级。
 */
function normalizeBusinessSyncIdentity(
  command: {
    recordUuid?: string | null;
    sourceVersion?: number | null;
    manifestChecksum?: string | null;
    organizationId?: number | null;
    accountId?: number | null;
  },
  taskKind: LocalUploadTaskKind,
): BusinessSyncIdentity {
  const recordUuid = normalizeOptionalText(
    command.recordUuid ?? null,
    RECORD_UUID_MAX,
    '稳定业务编号',
  );
  if (
    recordUuid !== null &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recordUuid)
  ) {
    throw invalid('稳定业务编号必须为 36 位 UUID 文本', { recordUuid });
  }
  const sourceVersion = normalizeOptionalPositiveInteger(command.sourceVersion ?? null, '业务版本');
  const manifestChecksum = normalizeChecksum(command.manifestChecksum ?? null);
  const organizationId = normalizeOptionalPositiveInteger(
    command.organizationId ?? null,
    '公司数据区',
  );
  const accountId = normalizeOptionalPositiveInteger(command.accountId ?? null, '原账号');

  if (taskKind !== 'BUSINESS_SYNC') {
    return { recordUuid, sourceVersion, manifestChecksum, organizationId, accountId };
  }

  const missing: string[] = [];
  if (recordUuid === null) missing.push('稳定业务编号');
  if (sourceVersion === null) missing.push('业务版本');
  if (manifestChecksum === null) missing.push('正文与原件清单摘要');
  if (organizationId === null) missing.push('公司数据区');
  if (accountId === null) missing.push('原账号');
  if (missing.length > 0) {
    throw new DomainError(
      LOCAL_RUNTIME_ERROR.UPLOAD_TASK_IDENTITY_MISSING,
      `业务同步任务必须登记身份事实：${missing.join('、')}`,
      { missing },
    );
  }

  return { recordUuid, sourceVersion, manifestChecksum, organizationId, accountId };
}

/** 任务种类归一：备份清单默认按备份上云登记，其余按业务同步登记 */
function normalizeUploadTaskKind(
  value: string | null | undefined,
  entityType: LocalEntityType,
): LocalUploadTaskKind {
  if (value === null || value === undefined) {
    return entityType === 'BACKUP_MANIFEST' ? 'BACKUP_UPLOAD' : 'BUSINESS_SYNC';
  }
  if (value !== 'BUSINESS_SYNC' && value !== 'BACKUP_UPLOAD') {
    throw invalid('上传任务种类无效', { taskKind: value });
  }
  return value;
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

/**
 * 归一化备份资产 ID：去空白后按上限校验，非空返回。
 *
 * 备份资产 ID 是 36 位 UUID 文本，用例层不自行 trim，统一在此归一。
 */
export function normalizeBackupId(value: string): string {
  return requireText(value, BACKUP_ID_MAX, '备份 ID');
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

/**
 * 记录包检查路径归一：必须为非空本机绝对路径（U盘挂载点或包目录）。
 * 只做形态归一，路径安全（穿越/逃逸）由记录包清单策略在解析层兜底。
 */
export function normalizePackagePath(value: string | undefined): string {
  return normalizePackageRootPath(value, '包路径必须为本机绝对路径（U盘挂载点或包目录）');
}

/**
 * 记录包导出目标归一：必须为非空本机绝对路径（U盘挂载点或目录）。
 * 目录覆盖防护（不存在或为空）由导出服务在写盘前断言。
 */
export function normalizePackageExportTarget(value: string | undefined): string {
  return normalizePackageRootPath(value, '导出目标必须是本机绝对路径（U盘挂载点或目录）');
}

/**
 * 记录包路径归一（**唯一实现**）：必须为非空本机绝对路径。
 *
 * 检查入口与导出入口此前各写了一遍同样的判空＋绝对路径判断；这里给出唯一一份，
 * 两侧只传各自的文案。路径安全（穿越/逃逸）不在本层，由清单策略在解析层兜底。
 */
export function normalizePackageRootPath(value: string | undefined, message: string): string {
  const rootPath = (value ?? '').trim();
  if (rootPath.length === 0 || !rootPath.startsWith('/')) {
    throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_PARAMS, message);
  }
  return rootPath;
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

/** 正整数归一（业务版本、公司数据区、账号 ID 等标识类字段） */
function normalizeOptionalPositiveInteger(value: number | null, fieldName: string): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw invalid(`${fieldName}必须为正整数`, { [fieldName]: value });
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
