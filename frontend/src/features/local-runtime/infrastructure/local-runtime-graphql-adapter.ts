// src/features/local-runtime/infrastructure/local-runtime-graphql-adapter.ts

import { executeGraphQL } from '@/shared/graphql';

import type {
  LocalRuntimeCompanySetting,
  LocalRuntimeStatus,
  LocalRuntimeViewerRole,
} from './local-runtime.types';

/**
 * 本地运行状态 GraphQL 数据访问层（任务 09 S1）。
 *
 * - 只读：仅消费 `localRuntimeStatus` 单个 Query，不发任何变更；
 * - 无入参：公司/设备范围由服务端按会话裁决，前端不得也无法指定
 *   （避免出现"前端传公司 ID 就会被信任"的越权面）；
 * - 失败一律以异常上抛，由 application 层归一为可展示消息，本层不做乐观降级。
 */

const LOCAL_RUNTIME_STATUS_QUERY = `
  query LocalRuntimeStatus {
    localRuntimeStatus {
      installationId
      localSiteName
      mappedOrganizationId
      mappedOrganizationCode
      viewerRole
      scopeOrganizationId
      service {
        apiStatus
        databaseStatus
        taskFactSource
        taskRecovery
      }
      storage {
        businessFileDirectory
        businessFileDirectoryWritable
        backupDirectory
        backupDirectoryWritable
      }
      tasks {
        pendingUploadCount
        uploadingUploadCount
        failedUploadCount
        succeededUploadCount
        runningBackupCount
        lastBackupStartedAt
        lastBackupFinishedAt
      }
      companies {
        organizationId
        backupEnabled
        backupIntervalHours
        nextBackupAt
        lastAutoSuccessAt
        lastAutoFailureAt
        failureReason
        autoUploadEnabled
        initializedAt
      }
      authorizations {
        organizationId
        activeCount
        revokedCount
        lastVerifiedAt
        credentialPurpose
      }
      generatedAt
    }
  }
`;

type LocalRuntimeStatusPayload = {
  localRuntimeStatus: LocalRuntimeStatus;
};

const VIEWER_ROLES: readonly LocalRuntimeViewerRole[] = [
  'ADMIN_LEVEL_1',
  'ADMIN_LEVEL_2',
  'ENGINEER',
];

/**
 * 载荷 → 视图的纯映射。
 *
 * 只做防御性归一（缺失数组补空、未知角色拒绝），不补造业务事实：
 * 角色无法识别说明前后端枚举不一致，宁可失败也不猜一个更宽的角色。
 */
export function mapLocalRuntimeStatus(payload: LocalRuntimeStatusPayload): LocalRuntimeStatus {
  const data = payload.localRuntimeStatus;

  if (!data || typeof data.installationId !== 'string' || data.installationId === '') {
    throw new Error('本地运行状态响应缺少安装标识');
  }

  if (!VIEWER_ROLES.includes(data.viewerRole)) {
    throw new Error(`本地运行状态响应包含未知角色：${String(data.viewerRole)}`);
  }

  return {
    ...data,
    authorizations: Array.isArray(data.authorizations)
      ? data.authorizations.map((authorization) => ({
          ...authorization,
          lastVerifiedAt: authorization.lastVerifiedAt ?? null,
        }))
      : [],
    companies: Array.isArray(data.companies)
      ? data.companies.map(
          (company): LocalRuntimeCompanySetting => ({
            ...company,
            failureReason: company.failureReason ?? null,
            lastAutoFailureAt: company.lastAutoFailureAt ?? null,
            lastAutoSuccessAt: company.lastAutoSuccessAt ?? null,
            nextBackupAt: company.nextBackupAt ?? null,
          }),
        )
      : [],
  };
}

export async function fetchLocalRuntimeStatus(): Promise<LocalRuntimeStatus> {
  const payload = await executeGraphQL<LocalRuntimeStatusPayload, Record<string, never>>(
    LOCAL_RUNTIME_STATUS_QUERY,
    {},
    { fetchPolicy: 'no-cache' },
  );

  return mapLocalRuntimeStatus(payload);
}

const UPDATE_LOCAL_BACKUP_PLAN_MUTATION = `
  mutation UpdateLocalBackupPlan(
    $organizationId: Int!
    $backupEnabled: Boolean
    $autoUploadEnabled: Boolean
  ) {
    updateLocalBackupPlan(
      organizationId: $organizationId
      backupEnabled: $backupEnabled
      autoUploadEnabled: $autoUploadEnabled
    ) {
      organizationId
      backupEnabled
      backupIntervalHours
      nextBackupAt
      autoUploadEnabled
      initializedAt
    }
  }
`;

/**
 * 修改公司维度的本地备份计划开关（任务 09 S4）。
 *
 * 本地自动备份与云自动上云**分开控制**；改开关不重置周期、不触发备份动作。
 * 准入由服务端裁决（工程师拒绝；一级管理员全局；二级管理员仅本公司）。
 */
export async function updateLocalBackupPlan(input: {
  organizationId: number;
  backupEnabled?: boolean;
  autoUploadEnabled?: boolean;
}): Promise<LocalRuntimeCompanySetting> {
  const data = await executeGraphQL<
    { updateLocalBackupPlan: LocalRuntimeCompanySetting },
    { organizationId: number; backupEnabled?: boolean; autoUploadEnabled?: boolean }
  >(UPDATE_LOCAL_BACKUP_PLAN_MUTATION, input);

  return data.updateLocalBackupPlan;
}
