// src/modules/lithography/local-runtime.mapper.ts
// 本地运行实体 → 安全快照（不含任何云端凭据；错误说明由写入方保证不含凭据）。

import { LocalBackupRunEntity } from './entities/local-backup-run.entity';
import { LocalInstallationEntity } from './entities/local-installation.entity';
import { LocalUploadTaskEntity } from './entities/local-upload-task.entity';
import {
  LocalBackupRunSnapshot,
  LocalInstallationSnapshot,
  LocalUploadTaskSnapshot,
} from './local-runtime.types';

export function toLocalInstallationSnapshot(
  entity: LocalInstallationEntity,
): LocalInstallationSnapshot {
  return {
    id: entity.id,
    installationId: entity.installationId,
    organizationId: entity.organizationId,
    organizationCodeSnapshot: entity.organizationCodeSnapshot,
    localSiteName: entity.localSiteName,
    autoUploadEnabled: entity.autoUploadEnabled,
    backupIntervalDays: entity.backupIntervalDays,
    lastBackupCompletedAt: entity.lastBackupCompletedAt,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}

export function toLocalUploadTaskSnapshot(entity: LocalUploadTaskEntity): LocalUploadTaskSnapshot {
  return {
    id: entity.id,
    installationId: entity.installationId,
    entityType: entity.entityType as LocalUploadTaskSnapshot['entityType'],
    entityLocalId: entity.entityLocalId,
    entityVersion: entity.entityVersion,
    idempotencyKey: entity.idempotencyKey,
    status: entity.status as LocalUploadTaskSnapshot['status'],
    attemptCount: entity.attemptCount,
    lastAttemptAt: entity.lastAttemptAt,
    remoteId: entity.remoteId,
    remoteReceipt: entity.remoteReceipt,
    errorCode: entity.errorCode,
    errorMessage: entity.errorMessage,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}

export function toLocalBackupRunSnapshot(entity: LocalBackupRunEntity): LocalBackupRunSnapshot {
  return {
    id: entity.id,
    installationId: entity.installationId,
    triggerType: entity.triggerType as LocalBackupRunSnapshot['triggerType'],
    status: entity.status as LocalBackupRunSnapshot['status'],
    startedAt: entity.startedAt,
    finishedAt: entity.finishedAt,
    manifestPath: entity.manifestPath,
    manifestChecksum: entity.manifestChecksum,
    byteSize: entity.byteSize,
    attachmentCount: entity.attachmentCount,
    schemaVersion: entity.schemaVersion,
    errorCode: entity.errorCode,
    errorMessage: entity.errorMessage,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}
