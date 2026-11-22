// src/features/local-runtime/ui/local-runtime-settings-panel.tsx

import { Alert, Descriptions } from 'antd';

import { type MessageKey, useI18n } from '@/shared/i18n';
import { PrimaryButton } from '@/shared/ui/buttons';
import { DataCard } from '@/shared/ui/data-card';
import { EmptyState } from '@/shared/ui/empty-state';
import { ErrorState } from '@/shared/ui/error-state';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { LoadingState } from '@/shared/ui/loading-state';
import { LocalBackupReasonText } from '@/shared/ui/local-backup-reason-text';
import { StatusPill } from '@/shared/ui/status-pill';

import { useLocalRuntimeStatus } from '../application/use-local-runtime-status';
import type {
  LocalRuntimeAuthorizationSummary,
  LocalRuntimeCompanySetting,
  LocalRuntimeStatus,
  LocalRuntimeTaskStatus,
  LocalRuntimeViewerRole,
} from '../infrastructure/local-runtime.types';

const ROLE_LABEL_KEY: Record<LocalRuntimeViewerRole, MessageKey> = {
  ADMIN_LEVEL_1: 'local-settings.role.adminLevel1',
  ADMIN_LEVEL_2: 'local-settings.role.adminLevel2',
  ENGINEER: 'local-settings.role.engineer',
};

/**
 * 本地设置只读面板（任务 09 R064）。
 *
 * 只展示服务端返回的真实事实：部署身份、服务/数据库/任务耐久来源、两个存储目录的
 * 配置值与可写状态、按查看者范围过滤后的公司备份计划。
 * 不提供任何编辑、切换公司、切换设备或"立即备份"入口——这些属 S3 的备份页与
 * 管理端配置，放在只读页会形成越权面。
 */
export function LocalRuntimeSettingsPanel() {
  const { t } = useI18n();
  const { state, reload } = useLocalRuntimeStatus();

  if (state.status === 'loading') {
    return <LoadingState label={t('local-settings.loading')} />;
  }

  if (state.status === 'forbidden') {
    return (
      <ErrorState
        title={t('local-settings.loadFailed')}
        description={state.message}
        action={
          <PrimaryButton onClick={() => void reload()}>{t('local-settings.reload')}</PrimaryButton>
        }
      />
    );
  }

  if (state.status === 'failed') {
    return (
      <ErrorState
        title={t('local-settings.loadFailed')}
        description={state.message}
        action={
          <PrimaryButton onClick={() => void reload()}>{t('local-settings.reload')}</PrimaryButton>
        }
      />
    );
  }

  return <LocalRuntimeSettingsView data={state.data} />;
}

function LocalRuntimeSettingsView({ data }: { data: LocalRuntimeStatus }) {
  const { t } = useI18n();
  const scopeText =
    data.scopeOrganizationId === null
      ? t('local-settings.value.globalScope')
      : String(data.scopeOrganizationId);
  const mappedOrganizationText =
    data.mappedOrganizationId === null
      ? t('local-settings.value.unmapped')
      : `${data.mappedOrganizationCode ?? t('local-settings.value.dash')} · ${data.mappedOrganizationId}`;

  return (
    <div className="page-stack">
      <Alert banner showIcon title={t('local-settings.notice.readonly')} type="info" />

      <DataCard title={t('local-settings.section.identity')}>
        <Descriptions
          column={{ lg: 2, md: 1, sm: 1, xs: 1 }}
          items={[
            {
              key: 'installationId',
              label: t('local-settings.field.installationId'),
              children: <code>{data.installationId}</code>,
            },
            {
              key: 'localSiteName',
              label: t('local-settings.field.localSiteName'),
              children: data.localSiteName ?? t('local-settings.value.dash'),
            },
            {
              key: 'mappedOrganization',
              label: t('local-settings.field.mappedOrganization'),
              children: mappedOrganizationText,
            },
            {
              key: 'viewerRole',
              label: t('local-settings.field.viewerRole'),
              children: t(ROLE_LABEL_KEY[data.viewerRole]),
            },
            {
              key: 'scope',
              label: t('local-settings.field.scope'),
              children: scopeText,
            },
            {
              key: 'generatedAt',
              label: t('local-settings.generatedAt'),
              children: formatDateTimeText(data.generatedAt),
            },
          ]}
        />
      </DataCard>

      <DataCard title={t('local-settings.section.service')}>
        <Descriptions
          column={{ lg: 2, md: 1, sm: 1, xs: 1 }}
          items={[
            {
              key: 'apiStatus',
              label: t('local-settings.field.apiStatus'),
              children: (
                <StatusPill tone={data.service.apiStatus === 'UP' ? 'ok' : 'critical'}>
                  {data.service.apiStatus}
                </StatusPill>
              ),
            },
            {
              key: 'databaseStatus',
              label: t('local-settings.field.databaseStatus'),
              children: (
                <StatusPill tone={data.service.databaseStatus === 'UP' ? 'ok' : 'critical'}>
                  {data.service.databaseStatus}
                </StatusPill>
              ),
            },
            {
              key: 'taskFactSource',
              label: t('local-settings.field.taskFactSource'),
              children: data.service.taskFactSource,
            },
            {
              key: 'taskRecovery',
              label: t('local-settings.field.taskRecovery'),
              children: data.service.taskRecovery,
            },
          ]}
        />
      </DataCard>

      <DataCard title={t('local-settings.section.storage')}>
        <Descriptions
          column={1}
          items={[
            {
              key: 'businessFileDirectory',
              label: t('local-settings.field.businessFileDirectory'),
              children: (
                <StorageDirectory
                  path={data.storage.businessFileDirectory}
                  writable={data.storage.businessFileDirectoryWritable}
                />
              ),
            },
            {
              key: 'backupDirectory',
              label: t('local-settings.field.backupDirectory'),
              children: (
                <StorageDirectory
                  path={data.storage.backupDirectory}
                  writable={data.storage.backupDirectoryWritable}
                />
              ),
            },
          ]}
        />
      </DataCard>

      <DataCard title={t('local-settings.section.tasks')}>
        {data.tasks ? (
          <TaskStatusBlock tasks={data.tasks} />
        ) : (
          <EmptyState title={t('local-settings.tasks.notVisible')} />
        )}
      </DataCard>

      <DataCard title={t('local-settings.section.authorizations')}>
        {data.authorizations.length === 0 ? (
          <EmptyState title={t('local-settings.authorizations.empty')} />
        ) : (
          <div className="page-stack">
            {data.authorizations.map((authorization) => (
              <AuthorizationBlock
                authorization={authorization}
                key={authorization.organizationId}
              />
            ))}
          </div>
        )}
      </DataCard>

      <DataCard title={t('local-settings.section.companies')}>
        {data.companies.length === 0 ? (
          <EmptyState title={t('local-settings.companies.empty')} />
        ) : (
          <div className="page-stack">
            {data.companies.map((company) => (
              <CompanySettingBlock company={company} key={company.organizationId} />
            ))}
          </div>
        )}
      </DataCard>
    </div>
  );
}

function StorageDirectory({ path, writable }: { path: string; writable: boolean }) {
  const { t } = useI18n();

  return (
    <span>
      <code>{path}</code>{' '}
      <StatusPill tone={writable ? 'ok' : 'warn'}>
        {writable ? t('local-settings.value.writable') : t('local-settings.value.notWritable')}
      </StatusPill>
    </span>
  );
}

function TaskStatusBlock({ tasks }: { tasks: LocalRuntimeTaskStatus }) {
  const { t } = useI18n();

  return (
    <Descriptions
      column={{ lg: 3, md: 2, sm: 1, xs: 1 }}
      items={[
        {
          key: 'pendingUploadCount',
          label: t('local-settings.field.pendingUploadCount'),
          children: tasks.pendingUploadCount,
        },
        {
          key: 'uploadingUploadCount',
          label: t('local-settings.field.uploadingUploadCount'),
          children: tasks.uploadingUploadCount,
        },
        {
          key: 'failedUploadCount',
          label: t('local-settings.field.failedUploadCount'),
          children: tasks.failedUploadCount,
        },
        {
          key: 'succeededUploadCount',
          label: t('local-settings.field.succeededUploadCount'),
          children: tasks.succeededUploadCount,
        },
        {
          key: 'runningBackupCount',
          label: t('local-settings.field.runningBackupCount'),
          children: tasks.runningBackupCount,
        },
        {
          key: 'lastBackupStartedAt',
          label: t('local-settings.field.lastBackupStartedAt'),
          children: tasks.lastBackupStartedAt
            ? formatDateTimeText(tasks.lastBackupStartedAt)
            : t('local-settings.value.dash'),
        },
        {
          key: 'lastBackupFinishedAt',
          label: t('local-settings.field.lastBackupFinishedAt'),
          children: tasks.lastBackupFinishedAt
            ? formatDateTimeText(tasks.lastBackupFinishedAt)
            : t('local-settings.value.dash'),
        },
      ]}
    />
  );
}

function AuthorizationBlock({
  authorization,
}: {
  authorization: LocalRuntimeAuthorizationSummary;
}) {
  const { t } = useI18n();

  return (
    <Descriptions
      bordered
      column={{ lg: 4, md: 2, sm: 1, xs: 1 }}
      items={[
        {
          key: 'organizationId',
          label: t('local-settings.companies.organization'),
          children: authorization.organizationId,
        },
        {
          key: 'activeCount',
          label: t('local-settings.authorizations.active'),
          children: authorization.activeCount,
        },
        {
          key: 'revokedCount',
          label: t('local-settings.authorizations.revoked'),
          children: authorization.revokedCount,
        },
        {
          key: 'lastVerifiedAt',
          label: t('local-settings.authorizations.lastVerifiedAt'),
          children: authorization.lastVerifiedAt
            ? formatDateTimeText(authorization.lastVerifiedAt)
            : t('local-settings.value.dash'),
        },
        {
          key: 'credentialPurpose',
          label: t('local-settings.authorizations.purpose'),
          children:
            authorization.credentialPurpose === 'BUSINESS_SYNC'
              ? t('local-settings.value.businessSync')
              : authorization.credentialPurpose,
        },
      ]}
    />
  );
}

function CompanySettingBlock({ company }: { company: LocalRuntimeCompanySetting }) {
  const { t } = useI18n();

  return (
    <Descriptions
      bordered
      column={{ lg: 3, md: 2, sm: 1, xs: 1 }}
      items={[
        {
          key: 'organizationId',
          label: t('local-settings.companies.organization'),
          children: company.organizationId,
        },
        {
          key: 'backupEnabled',
          label: t('local-settings.companies.backupEnabled'),
          children: (
            <StatusPill tone={company.backupEnabled ? 'ok' : 'neutral'}>
              {company.backupEnabled
                ? t('local-settings.value.enabled')
                : t('local-settings.value.disabled')}
            </StatusPill>
          ),
        },
        {
          key: 'backupIntervalHours',
          label: t('local-settings.companies.interval'),
          children: `${company.backupIntervalHours} ${t('local-settings.units.hours')}`,
        },
        {
          key: 'autoUploadEnabled',
          label: t('local-settings.companies.autoUpload'),
          children: (
            <StatusPill tone={company.autoUploadEnabled ? 'ok' : 'neutral'}>
              {company.autoUploadEnabled
                ? t('local-settings.value.enabled')
                : t('local-settings.value.disabled')}
            </StatusPill>
          ),
        },
        {
          key: 'nextBackupAt',
          label: t('local-settings.companies.nextBackupAt'),
          children: company.nextBackupAt
            ? formatDateTimeText(company.nextBackupAt)
            : t('local-settings.value.dash'),
        },
        {
          key: 'lastAutoSuccessAt',
          label: t('local-settings.companies.lastSuccess'),
          children: company.lastAutoSuccessAt
            ? formatDateTimeText(company.lastAutoSuccessAt)
            : t('local-settings.value.dash'),
        },
        {
          key: 'lastAutoFailureAt',
          label: t('local-settings.companies.lastFailure'),
          children: company.lastAutoFailureAt
            ? formatDateTimeText(company.lastAutoFailureAt)
            : t('local-settings.value.dash'),
        },
        {
          key: 'failureReason',
          label: t('local-settings.companies.failureReason'),
          children: company.failureReason ? (
            <LocalBackupReasonText reason={company.failureReason} />
          ) : (
            t('local-settings.value.dash')
          ),
        },
        {
          key: 'initializedAt',
          label: t('local-settings.companies.initializedAt'),
          children: formatDateTimeText(company.initializedAt),
        },
      ]}
    />
  );
}
