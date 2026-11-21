// src/features/local-backup/infrastructure/local-backup-graphql-adapter.ts

import { executeGraphQL } from '@/shared/graphql';

import type {
  LocalBackupCleanupMode,
  LocalBackupCleanupResult,
  LocalBackupRecordDetail,
  LocalBackupRecordPage,
  LocalBackupSetting,
  LocalRestoreCapability,
  LocalRestorePrecheckResult,
  StartManualLocalBackupResult,
} from './local-backup.types';

/**
 * 备份与恢复 GraphQL 数据访问层（任务 09 S3／S4）。
 *
 * - 公司范围由服务端按 Session 裁决，前端查询不传公司参数；
 * - 写操作只有三个：手动备份触发（本人范围）、恢复预检（管理员专属）与本地包清理（管理员过期清理）；
 * - 失败一律以异常上抛，由 application 层归一为可展示消息，本层不做乐观降级。
 */

const RECORD_FIELDS = `
  backupId
  organizationId
  runId
  installationId
  triggerType
  runStatus
  startedAt
  finishedAt
  createdAt
  byteSize
  localStatus
  localPackageRetained
  cloudStatus
  cloudReceiptPresent
  manifestChecksum
  verifiedAt
  retentionUntil
  failureReason
  localCleanupError
  attemptCount
  lastAttemptAt
  deletedAt
`;

const LOCAL_BACKUP_RECORDS_QUERY = `
  query LocalBackupRecords($pagination: LocalBackupRecordPaginationInput) {
    localBackupRecords(pagination: $pagination) {
      items {
        ${RECORD_FIELDS}
      }
      total
      page
      pageSize
    }
  }
`;

const LOCAL_BACKUP_RECORD_QUERY = `
  query LocalBackupRecord($backupId: String!) {
    localBackupRecord(backupId: $backupId) {
      record {
        ${RECORD_FIELDS}
      }
      schemaVersion
      protectionKeyId
      fileCount
      originalCount
      scope {
        table
        rowCount
        lastUpdatedAt
      }
      manifestReadable
    }
  }
`;

const LOCAL_BACKUP_SETTINGS_QUERY = `
  query LocalBackupSettings {
    localBackupSettings {
      organizationId
      installationId
      backupEnabled
      backupIntervalHours
      nextBackupAt
      lastAutoSuccessAt
      lastAutoFailureAt
      failureReason
      autoUploadEnabled
      planIntervalHours
      retentionDays
      lastRunStatus
      lastRunStartedAt
      lastRunFinishedAt
      lastAssetCloudStatus
      lastAssetLocalStatus
    }
  }
`;

const START_MANUAL_LOCAL_BACKUP_MUTATION = `
  mutation StartManualLocalBackup($organizationId: Int) {
    startManualLocalBackup(organizationId: $organizationId) {
      runId
      organizationId
      status
      backupId
      manifestChecksum
      byteSize
      errorCode
      errorMessage
      uploadStatus
      cleanupStatus
    }
  }
`;

const PRECHECK_LOCAL_RESTORE_MUTATION = `
  mutation PrecheckLocalRestore($backupId: String!) {
    precheckLocalRestore(backupId: $backupId) {
      restoreId
      outcome
      checkedAt
      targetBackupId
      targetOrganizationId
      targetInstallationId
      manifestChecksum
      packageReadable
      fileCount
      originalCount
      verifiedFileCount
      protectionBackupId
      protectionCreated
      findings {
        code
        message
      }
    }
  }
`;

const CLEANUP_LOCAL_BACKUP_PACKAGES_MUTATION = `
  mutation CleanupLocalBackupPackages($mode: LocalBackupCleanupMode!, $organizationId: Int) {
    cleanupLocalBackupPackages(mode: $mode, organizationId: $organizationId) {
      mode
      organizationId
      available
      reason
      targetCount
      cleaned
      retained
      items {
        backupId
        outcome
        reason
      }
    }
  }
`;

const LOCAL_RESTORE_CAPABILITY_QUERY = `
  query LocalRestoreCapability {
    localRestoreCapability {
      executionAvailable
      reason
    }
  }
`;

type LocalBackupRecordPaginationVariables = {
  pagination: {
    page: number;
    pageSize: number;
    withTotal: boolean;
  };
};

export async function fetchLocalBackupRecords(page: number, pageSize: number) {
  const variables: LocalBackupRecordPaginationVariables = {
    pagination: { page, pageSize, withTotal: true },
  };
  const payload = await executeGraphQL<
    { localBackupRecords: LocalBackupRecordPage },
    LocalBackupRecordPaginationVariables
  >(LOCAL_BACKUP_RECORDS_QUERY, variables, { fetchPolicy: 'no-cache' });

  return payload.localBackupRecords;
}

export async function fetchLocalBackupRecord(backupId: string): Promise<LocalBackupRecordDetail> {
  const payload = await executeGraphQL<
    { localBackupRecord: LocalBackupRecordDetail },
    { backupId: string }
  >(LOCAL_BACKUP_RECORD_QUERY, { backupId }, { fetchPolicy: 'no-cache' });

  return payload.localBackupRecord;
}

export async function fetchLocalBackupSettings(): Promise<LocalBackupSetting[]> {
  const payload = await executeGraphQL<{ localBackupSettings: LocalBackupSetting[] }, Record<string, never>>(
    LOCAL_BACKUP_SETTINGS_QUERY,
    {},
    { fetchPolicy: 'no-cache' },
  );

  return payload.localBackupSettings ?? [];
}

export async function startManualLocalBackup(
  organizationId?: number,
): Promise<StartManualLocalBackupResult> {
  const payload = await executeGraphQL<
    { startManualLocalBackup: StartManualLocalBackupResult },
    { organizationId: number | null }
  >(
    START_MANUAL_LOCAL_BACKUP_MUTATION,
    { organizationId: organizationId ?? null },
    { fetchPolicy: 'no-cache' },
  );

  return payload.startManualLocalBackup;
}

export async function precheckLocalRestore(backupId: string): Promise<LocalRestorePrecheckResult> {
  const payload = await executeGraphQL<
    { precheckLocalRestore: LocalRestorePrecheckResult },
    { backupId: string }
  >(PRECHECK_LOCAL_RESTORE_MUTATION, { backupId }, { fetchPolicy: 'no-cache' });

  return payload.precheckLocalRestore;
}

export async function cleanupLocalBackupPackages(
  mode: LocalBackupCleanupMode,
  organizationId?: number,
): Promise<LocalBackupCleanupResult> {
  const payload = await executeGraphQL<
    { cleanupLocalBackupPackages: LocalBackupCleanupResult },
    { mode: LocalBackupCleanupMode; organizationId: number | null }
  >(
    CLEANUP_LOCAL_BACKUP_PACKAGES_MUTATION,
    { mode, organizationId: organizationId ?? null },
    { fetchPolicy: 'no-cache' },
  );

  return payload.cleanupLocalBackupPackages;
}

export async function fetchLocalRestoreCapability(): Promise<LocalRestoreCapability> {
  const payload = await executeGraphQL<
    { localRestoreCapability: LocalRestoreCapability },
    Record<string, never>
  >(LOCAL_RESTORE_CAPABILITY_QUERY, {}, { fetchPolicy: 'no-cache' });

  return payload.localRestoreCapability;
}
