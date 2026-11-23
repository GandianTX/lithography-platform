// src/features/local-backup/infrastructure/local-backup-graphql-adapter.ts

import { executeGraphQL } from '@/shared/graphql';
import { fetchRestWithAuthRetry } from '@/shared/http/rest-request';

import type {
  LocalBackupCleanupMode,
  LocalBackupCleanupResult,
  LocalBackupCloudPackageDownload,
  LocalBackupCloudPackageList,
  LocalBackupRecordDetail,
  LocalBackupRecordPage,
  LocalBackupSetting,
  LocalRestoreAcceptance,
  LocalRestoreCapability,
  LocalRestoreExecution,
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

const ACCEPT_LOCAL_RESTORE_MUTATION = `
  mutation AcceptLocalRestore($restoreId: String!) {
    acceptLocalRestore(restoreId: $restoreId) {
      restoreId
      accepted
      backupId
      protectionBackupId
      organizationId
      acceptedAt
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

const LOCAL_BACKUP_CLOUD_PACKAGES_QUERY = `
  query LocalBackupCloudPackages($organizationId: Int) {
    localBackupCloudPackages(organizationId: $organizationId) {
      organizationId
      packages {
        packageId
        organizationId
        backupId
        createdAt
        byteSize
        checksumSha256
      }
    }
  }
`;

const EXECUTE_LOCAL_RESTORE_MUTATION = `
  mutation ExecuteLocalRestore($restoreId: String!) {
    executeLocalRestore(restoreId: $restoreId) {
      restoreId
      status
      released
      holdRetained
      restoredRecords
      restoredOriginals
      restoredQueue
      reasonCode
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
  const payload = await executeGraphQL<
    { localBackupSettings: LocalBackupSetting[] },
    Record<string, never>
  >(LOCAL_BACKUP_SETTINGS_QUERY, {}, { fetchPolicy: 'no-cache' });

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

/**
 * 恢复受理（管理员专属）。
 *
 * **受理 ≠ 恢复**：只写入"已被授权确认"的事实，不恢复数据、不冻结写入、不产生成功结论；
 * 服务端在受理前会再次检查权限、目标设备与保护副本。
 */
export async function acceptLocalRestore(restoreId: string): Promise<LocalRestoreAcceptance> {
  const payload = await executeGraphQL<
    { acceptLocalRestore: LocalRestoreAcceptance },
    { restoreId: string }
  >(ACCEPT_LOCAL_RESTORE_MUTATION, { restoreId }, { fetchPolicy: 'no-cache' });

  return payload.acceptLocalRestore;
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

/**
 * 云端备份包清单（任务 09 S3／A09-07）。
 *
 * 范围由服务端按 Session 裁决：前端不传公司参数（一级管理员可显式指定）。
 * 云服务未接入时服务端按受控原因码失败关闭——前端**不伪造可用包**。
 */
export async function fetchLocalBackupCloudPackages(
  organizationId?: number,
): Promise<LocalBackupCloudPackageList> {
  const payload = await executeGraphQL<
    { localBackupCloudPackages: LocalBackupCloudPackageList },
    { organizationId: number | null }
  >(
    LOCAL_BACKUP_CLOUD_PACKAGES_QUERY,
    { organizationId: organizationId ?? null },
    { fetchPolicy: 'no-cache' },
  );

  return payload.localBackupCloudPackages;
}

/**
 * 执行恢复（管理员专属）。
 *
 * **受理 ≠ 恢复**：本 mutation 才真正写入数据；失败时服务端保持停写停传并保留保护副本，
 * 返回的 `released=false` 必须如实呈现，不得显示为"已恢复"。
 */
export async function executeLocalRestore(restoreId: string): Promise<LocalRestoreExecution> {
  const payload = await executeGraphQL<
    { executeLocalRestore: LocalRestoreExecution },
    { restoreId: string }
  >(EXECUTE_LOCAL_RESTORE_MUTATION, { restoreId }, { fetchPolicy: 'no-cache' });

  return payload.executeLocalRestore;
}

/**
 * 云端备份包授权下载（REST 字节流）。
 *
 * - 只给字节，**不触发恢复**（下载权限 ≠ 恢复权限）；
 * - 云服务未接入时服务端返回受控错误，前端按"不可用"如实提示，不给假成功。
 */
export async function downloadLocalBackupCloudPackage(params: {
  packageId: string;
  organizationId?: number;
}): Promise<LocalBackupCloudPackageDownload> {
  const query = new URLSearchParams();
  if (params.organizationId !== undefined) {
    query.set('organizationId', String(params.organizationId));
  }
  const suffix = query.toString().length > 0 ? `?${query.toString()}` : '';
  const url = `/api/local-runtime/backup/cloud-packages/${encodeURIComponent(params.packageId)}/download${suffix}`;

  let response: Response;
  try {
    response = await fetchRestWithAuthRetry(url, {});
  } catch {
    return { ok: false, blob: null, filename: null, reason: 'download-failed' };
  }

  if (!response.ok) {
    return {
      ok: false,
      blob: null,
      filename: null,
      reason: response.status === 404 ? 'not-found' : 'not-available',
    };
  }

  try {
    const blob = await response.blob();
    return {
      ok: true,
      blob,
      filename: resolveDownloadFilename(
        response.headers.get('Content-Disposition'),
        params.packageId,
      ),
      reason: null,
    };
  } catch {
    return { ok: false, blob: null, filename: null, reason: 'download-failed' };
  }
}

/**
 * 解析服务端给的文件名：`Content-Disposition: attachment; filename*=UTF-8''<编码名>`。
 *
 * 取不到就退回按包 id 生成的名字（**只用包 id**，不引入外部输入），
 * 避免把服务端自由文本直接当文件名。
 */
function resolveDownloadFilename(contentDisposition: string | null, packageId: string): string {
  const fallback = `backup-${packageId}.bin`;
  if (contentDisposition === null) {
    return fallback;
  }
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
  if (encoded?.[1] !== undefined) {
    try {
      const decoded = decodeURIComponent(encoded[1]);
      return decoded.length > 0 ? decoded : fallback;
    } catch {
      return fallback;
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(contentDisposition);
  const value = plain?.[1]?.trim();
  return value !== undefined && value.length > 0 ? value : fallback;
}
