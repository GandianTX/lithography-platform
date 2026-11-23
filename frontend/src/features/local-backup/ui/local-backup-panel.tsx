// src/features/local-backup/ui/local-backup-panel.tsx

import { useState } from 'react';
import { Alert, Descriptions, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { useI18n } from '@/shared/i18n';
import { PrimaryButton, SecondaryButton } from '@/shared/ui/buttons';
import { DataCard } from '@/shared/ui/data-card';
import { EmptyState } from '@/shared/ui/empty-state';
import { ErrorState } from '@/shared/ui/error-state';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { LoadingState } from '@/shared/ui/loading-state';
import { LocalBackupReasonText } from '@/shared/ui/local-backup-reason-text';
import { StatusPill, type StatusPillTone } from '@/shared/ui/status-pill';

import {
  type ActionState,
  useCleanupLocalBackupPackages,
  useCloudPackageDownload,
  useLocalBackupCloudPackages,
  useLocalBackupRecords,
  useLocalBackupSettings,
  useLocalRestoreCapability,
  useManualLocalBackup,
  useRestoreAcceptance,
  useRestoreExecution,
  useRestorePrecheck,
} from '../application/use-local-backup';
import type {
  LocalBackupCleanupItem,
  LocalBackupCleanupResult,
  LocalBackupCloudPackage,
  LocalBackupCloudPackageDownload,
  LocalBackupRecord,
  LocalBackupSetting,
  LocalRestoreExecution,
  LocalRestorePrecheckResult,
  StartManualLocalBackupResult,
} from '../infrastructure/local-backup.types';

/**
 * 备份与恢复面板（任务 09 S3／S4，任务书第 12 节）。
 *
 * 只呈现服务端返回的真实事实：
 * - 自动备份设置：下次计划时间、最近结果、约 72 小时周期与约 30 天保留窗口（只读）；
 * - 手动备份：真实触发受保护包生成，上云与清理阶段按实际状态展示；
 * - 备份记录：备份/时间、类型/大小、本地包、云备份、校验与操作；
 * - 恢复：如实呈现当前环境是否具备执行能力，不可用时说明原因。
 */

const PAGE_SIZE = 20;

export function LocalBackupPanel({ canPrecheck }: { canPrecheck: boolean }) {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const records = useLocalBackupRecords(page, PAGE_SIZE);
  const settings = useLocalBackupSettings();
  const capability = useLocalRestoreCapability();
  const manual = useManualLocalBackup();
  const cleanup = useCleanupLocalBackupPackages();
  const precheck = useRestorePrecheck();
  const accept = useRestoreAcceptance();
  const execute = useRestoreExecution();
  const cloudPackages = useLocalBackupCloudPackages();
  const cloudDownload = useCloudPackageDownload();
  // 恢复预检是服务端的一级管理员动作：前端只做**展示性**收敛，
  // 不作为授权依据（最终裁决仍在服务端）。角色由页面层从会话解析后传入
  // ——feature 之间不互相依赖（前端依赖规则）。

  return (
    <div className="page-stack">
      <AutoBackupSection state={settings.state} />

      <ManualBackupSection
        actionState={manual.state}
        cleanupState={cleanup.state}
        onTrigger={() => void runManualBackupAndCleanup(manual, cleanup)}
      />

      <BackupRecordsSection
        canPrecheck={canPrecheck}
        state={records.state}
        onPrecheck={(backupId) => {
          // 换备份重新预检 ⇒ 上一轮的受理/执行结论作废
          // （否则会给另一份备份显示"执行本次恢复"入口）
          accept.reset();
          execute.reset();
          void precheck.trigger(backupId);
        }}
        onReload={() => void records.reload()}
        setPage={setPage}
      />

      <RestoreSection capabilityState={capability.state} precheckState={precheck.state} />

      <CloudPackagesSection
        downloadState={cloudDownload.state}
        state={cloudPackages.state}
        onDownload={(packageId) => void cloudDownload.trigger(packageId)}
      />

      {precheck.state.status === 'succeeded' ? (
        <PrecheckResultCard
          acceptState={accept.state}
          canExecute={canPrecheck}
          executeState={execute.state}
          onAccept={(restoreId) => void accept.trigger(restoreId)}
          onExecute={(restoreId) => void execute.trigger(restoreId)}
          result={precheck.state.data}
        />
      ) : null}
      {precheck.state.status === 'forbidden' ? (
        <DataCard title={t('local-backup.restore.precheckTitle')}>
          <ErrorState
            description={precheck.state.message}
            title={t('local-backup.restore.precheckFailed')}
          />
        </DataCard>
      ) : null}
      {precheck.state.status === 'failed' ? (
        <DataCard title={t('local-backup.restore.precheckTitle')}>
          <ErrorState
            description={precheck.state.message}
            title={t('local-backup.restore.precheckFailed')}
          />
        </DataCard>
      ) : null}
    </div>
  );
}

/**
 * 受控原因码文案：未知码走通用兜底，不把后端自由文本原样渲染 */
function ReasonText({ reason }: { reason: string | null | undefined }) {
  return <LocalBackupReasonText reason={reason} />;
}

/** 手动备份并清理：先生成，再进入清理阶段（无完整云端回执时如实不可用） */
async function runManualBackupAndCleanup(
  manual: ReturnType<typeof useManualLocalBackup>,
  cleanup: ReturnType<typeof useCleanupLocalBackupPackages>,
): Promise<void> {
  const result = await manual.trigger();
  if (!result || result.status !== 'SUCCEEDED') {
    return;
  }
  await cleanup.trigger('MANUAL');
}

function AutoBackupSection({
  state,
}: {
  state: ReturnType<typeof useLocalBackupSettings>['state'];
}) {
  const { t } = useI18n();

  if (state.status === 'loading') {
    return (
      <DataCard title={t('local-backup.auto.title')}>
        <LoadingState label={t('local-backup.loading')} />
      </DataCard>
    );
  }

  if (state.status === 'forbidden') {
    return (
      <DataCard title={t('local-backup.auto.title')}>
        <ErrorState description={state.message} title={t('local-backup.auto.loadFailed')} />
      </DataCard>
    );
  }

  if (state.status === 'failed') {
    return (
      <DataCard title={t('local-backup.auto.title')}>
        <ErrorState description={state.message} title={t('local-backup.auto.loadFailed')} />
      </DataCard>
    );
  }

  if (state.data.length === 0) {
    return (
      <DataCard title={t('local-backup.auto.title')}>
        <EmptyState title={t('local-backup.auto.empty')} />
      </DataCard>
    );
  }

  return (
    <DataCard title={t('local-backup.auto.title')}>
      <div className="page-stack">
        {state.data.map((setting) => (
          <AutoBackupSettingCard key={setting.organizationId} setting={setting} />
        ))}
      </div>
    </DataCard>
  );
}

function AutoBackupSettingCard({ setting }: { setting: LocalBackupSetting }) {
  const { t } = useI18n();

  return (
    <Descriptions
      bordered
      column={{ lg: 3, md: 2, sm: 1, xs: 1 }}
      items={[
        {
          key: 'organizationId',
          label: t('local-backup.auto.organization'),
          children: setting.organizationId,
        },
        {
          key: 'backupEnabled',
          label: t('local-backup.auto.enabled'),
          children: (
            <StatusPill tone={setting.backupEnabled ? 'ok' : 'neutral'}>
              {setting.backupEnabled
                ? t('local-backup.value.enabled')
                : t('local-backup.value.disabled')}
            </StatusPill>
          ),
        },
        {
          key: 'autoUploadEnabled',
          label: t('local-backup.auto.autoUpload'),
          children: (
            <StatusPill tone={setting.autoUploadEnabled ? 'ok' : 'neutral'}>
              {setting.autoUploadEnabled
                ? t('local-backup.value.enabled')
                : t('local-backup.value.disabled')}
            </StatusPill>
          ),
        },
        {
          key: 'nextBackupAt',
          label: t('local-backup.auto.nextBackupAt'),
          children: setting.nextBackupAt
            ? formatDateTimeText(setting.nextBackupAt)
            : t('local-backup.value.dash'),
        },
        {
          key: 'lastAutoSuccessAt',
          label: t('local-backup.auto.lastSuccess'),
          children: setting.lastAutoSuccessAt
            ? formatDateTimeText(setting.lastAutoSuccessAt)
            : t('local-backup.value.dash'),
        },
        {
          key: 'lastAutoFailureAt',
          label: t('local-backup.auto.lastFailure'),
          children: setting.lastAutoFailureAt
            ? formatDateTimeText(setting.lastAutoFailureAt)
            : t('local-backup.value.dash'),
        },
        {
          key: 'lastRunStatus',
          label: t('local-backup.auto.lastRunStatus'),
          children: setting.lastRunStatus ?? t('local-backup.value.dash'),
        },
        {
          key: 'planIntervalHours',
          label: t('local-backup.auto.planInterval'),
          children: `${setting.planIntervalHours} ${t('local-backup.units.hours')}`,
        },
        {
          key: 'retentionDays',
          label: t('local-backup.auto.retention'),
          children: `${setting.retentionDays} ${t('local-backup.units.days')}`,
        },
        {
          key: 'failureReason',
          label: t('local-backup.auto.failureReason'),
          children: setting.failureReason ?? t('local-backup.value.dash'),
        },
      ]}
    />
  );
}

function ManualBackupSection({
  actionState,
  cleanupState,
  onTrigger,
}: {
  actionState: ActionState<StartManualLocalBackupResult>;
  cleanupState: ActionState<LocalBackupCleanupResult>;
  onTrigger: () => void;
}) {
  const { t } = useI18n();
  const running = actionState.status === 'running' || cleanupState.status === 'running';

  return (
    <DataCard
      extra={
        <PrimaryButton disabled={running} loading={running} onClick={onTrigger}>
          {t('local-backup.manual.trigger')}
        </PrimaryButton>
      }
      title={t('local-backup.manual.title')}
    >
      <div className="page-stack">
        <Alert banner showIcon type="info" title={t('local-backup.manual.notice')} />
        {actionState.status === 'succeeded' ? (
          <ManualBackupResult result={actionState.data} />
        ) : null}
        {actionState.status === 'forbidden' ? (
          <ErrorState description={actionState.message} title={t('local-backup.manual.failed')} />
        ) : null}
        {actionState.status === 'failed' ? (
          <ErrorState description={actionState.message} title={t('local-backup.manual.failed')} />
        ) : null}
        {cleanupState.status === 'running' ? (
          <LoadingState label={t('local-backup.manual.cleanupRunning')} />
        ) : null}
        {cleanupState.status === 'succeeded' ? (
          <CleanupResultCard result={cleanupState.data} />
        ) : null}
        {cleanupState.status === 'forbidden' ? (
          <ErrorState
            description={cleanupState.message}
            title={t('local-backup.manual.cleanupFailed')}
          />
        ) : null}
        {cleanupState.status === 'failed' ? (
          <ErrorState
            description={cleanupState.message}
            title={t('local-backup.manual.cleanupFailed')}
          />
        ) : null}
      </div>
    </DataCard>
  );
}

/** 清理结果：已清理与仍保留分别呈现，不合并成一个结论 */
function CleanupResultCard({ result }: { result: LocalBackupCleanupResult }) {
  const { t } = useI18n();
  const unavailable = !result.available;
  const partiallyFailed = result.retained > 0;

  const columns: ColumnsType<LocalBackupCleanupItem> = [
    {
      key: 'backupId',
      title: t('local-backup.field.backupId'),
      render: (_, item) => <code>{item.backupId}</code>,
    },
    {
      key: 'outcome',
      title: t('local-backup.manual.cleanupOutcome'),
      render: (_, item) => (
        <StatusPill tone={item.outcome === 'CLEANED' ? 'ok' : 'warn'}>
          {item.outcome === 'CLEANED'
            ? t('local-backup.manual.cleaned')
            : t('local-backup.manual.retained')}
        </StatusPill>
      ),
    },
    {
      key: 'reason',
      title: t('local-backup.manual.retainedReason'),
      render: (_, item) => <ReasonText reason={item.reason} />,
    },
  ];

  return (
    <div className="page-stack">
      <Alert
        banner
        showIcon
        type={unavailable || partiallyFailed ? 'warning' : 'success'}
        title={
          unavailable
            ? t('local-backup.manual.cleanupUnavailable')
            : t('local-backup.manual.cleanupDone', {
                cleaned: result.cleaned,
                retained: result.retained,
              })
        }
        description={unavailable ? <ReasonText reason={result.reason} /> : undefined}
      />
      {result.items.length > 0 ? (
        <Table<LocalBackupCleanupItem>
          columns={columns}
          dataSource={result.items}
          locale={{ emptyText: t('local-backup.manual.cleanupEmpty') }}
          pagination={false}
          rowKey="backupId"
          scroll={{ x: 560 }}
          size="small"
        />
      ) : null}
    </div>
  );
}

function ManualBackupResult({ result }: { result: StartManualLocalBackupResult }) {
  const { t } = useI18n();

  return (
    <Descriptions
      bordered
      column={{ lg: 3, md: 2, sm: 1, xs: 1 }}
      items={[
        {
          key: 'status',
          label: t('local-backup.manual.generation'),
          children: (
            <StatusPill tone={result.status === 'SUCCEEDED' ? 'ok' : 'critical'}>
              {result.status}
            </StatusPill>
          ),
        },
        {
          key: 'backupId',
          label: t('local-backup.field.backupId'),
          children: result.backupId ? <code>{result.backupId}</code> : t('local-backup.value.dash'),
        },
        {
          key: 'byteSize',
          label: t('local-backup.field.byteSize'),
          children:
            result.byteSize === null
              ? t('local-backup.value.dash')
              : `${result.byteSize} ${t('local-backup.units.bytes')}`,
        },
        {
          key: 'uploadStatus',
          label: t('local-backup.manual.upload'),
          children: result.uploadStatus,
        },
        {
          key: 'cleanupStatus',
          label: t('local-backup.manual.cleanup'),
          children: result.cleanupStatus,
        },
        {
          key: 'errorMessage',
          label: t('local-backup.field.errorMessage'),
          children: result.errorMessage ? (
            <ReasonText reason={result.errorMessage} />
          ) : (
            t('local-backup.value.dash')
          ),
        },
      ]}
    />
  );
}

function BackupRecordsSection({
  canPrecheck,
  state,
  onPrecheck,
  onReload,
  setPage,
}: {
  canPrecheck: boolean;
  state: ReturnType<typeof useLocalBackupRecords>['state'];
  onPrecheck: (backupId: string) => void;
  onReload: () => void;
  setPage: (next: number) => void;
}) {
  const { t } = useI18n();

  if (state.status === 'loading') {
    return (
      <DataCard title={t('local-backup.records.title')}>
        <LoadingState label={t('local-backup.loading')} />
      </DataCard>
    );
  }

  if (state.status === 'forbidden') {
    // 权限不足：重试无用，不给重试入口，只如实说明原因
    return (
      <DataCard title={t('local-backup.records.title')}>
        <ErrorState description={state.message} title={t('local-backup.error.forbiddenTitle')} />
      </DataCard>
    );
  }

  if (state.status === 'failed') {
    return (
      <DataCard title={t('local-backup.records.title')}>
        <ErrorState
          action={<SecondaryButton onClick={onReload}>{t('local-backup.reload')}</SecondaryButton>}
          description={state.message}
          title={t('local-backup.records.loadFailed')}
        />
      </DataCard>
    );
  }

  if (state.data.items.length === 0) {
    return (
      <DataCard title={t('local-backup.records.title')}>
        <EmptyState title={t('local-backup.records.empty')} />
      </DataCard>
    );
  }

  const columns: ColumnsType<LocalBackupRecord> = [
    {
      key: 'backup',
      title: t('local-backup.field.backupAndTime'),
      render: (_, record) => (
        <div>
          <code>{record.backupId}</code>
          <div>{formatDateTimeText(record.startedAt)}</div>
        </div>
      ),
    },
    {
      key: 'typeAndSize',
      title: t('local-backup.field.typeAndSize'),
      render: (_, record) => (
        <div>
          <div>{record.triggerType ?? t('local-backup.value.unknown')}</div>
          <div>
            {record.byteSize === null
              ? t('local-backup.value.dash')
              : `${record.byteSize} ${t('local-backup.units.bytes')}`}
          </div>
        </div>
      ),
    },
    {
      key: 'local',
      title: t('local-backup.field.localPackage'),
      render: (_, record) => (
        <StatusPill tone={localStatusTone(record)}>{record.localStatus}</StatusPill>
      ),
    },
    {
      key: 'cloud',
      title: t('local-backup.field.cloudBackup'),
      render: (_, record) => (
        <StatusPill tone={cloudStatusTone(record.cloudStatus)}>{record.cloudStatus}</StatusPill>
      ),
    },
    {
      key: 'checksum',
      title: t('local-backup.field.checksum'),
      render: (_, record) => (
        <div>
          <div>
            {record.manifestChecksum
              ? `${record.manifestChecksum.slice(0, 12)}…`
              : t('local-backup.value.dash')}
          </div>
          <div>
            {record.verifiedAt
              ? formatDateTimeText(record.verifiedAt)
              : t('local-backup.records.notVerified')}
          </div>
        </div>
      ),
    },
    {
      key: 'actions',
      title: t('local-backup.field.actions'),
      render: (_, record) =>
        canPrecheck ? (
          <SecondaryButton onClick={() => onPrecheck(record.backupId)}>
            {t('local-backup.restore.precheckAction')}
          </SecondaryButton>
        ) : (
          <span>{t('local-backup.value.dash')}</span>
        ),
    },
  ];

  const total = state.data.total ?? state.data.items.length;

  return (
    <DataCard title={t('local-backup.records.title')}>
      <div className="page-stack">
        <Table<LocalBackupRecord>
          columns={columns}
          dataSource={state.data.items}
          locale={{ emptyText: t('local-backup.records.empty') }}
          pagination={{
            current: state.data.page,
            onChange: setPage,
            pageSize: state.data.pageSize,
            showSizeChanger: false,
            showTotal: (count) => t('local-backup.records.total', { count }),
            total,
          }}
          rowKey="backupId"
          scroll={{ x: 900 }}
          size="small"
        />
      </div>
    </DataCard>
  );
}

function localStatusTone(record: LocalBackupRecord): StatusPillTone {
  if (record.localStatus === 'CLEANED') {
    return 'neutral';
  }
  if (record.localStatus === 'FAILED') {
    return 'critical';
  }
  return record.localStatus === 'CLEANING' ? 'warn' : 'ok';
}

function cloudStatusTone(status: LocalBackupRecord['cloudStatus']): StatusPillTone {
  if (status === 'SUCCEEDED') {
    return 'ok';
  }
  if (status === 'FAILED') {
    return 'critical';
  }
  return status === 'UPLOADING' ? 'warn' : 'neutral';
}

function RestoreSection({
  capabilityState,
  precheckState,
}: {
  capabilityState: ReturnType<typeof useLocalRestoreCapability>['state'];
  precheckState: ActionState<LocalRestorePrecheckResult>;
}) {
  const { t } = useI18n();

  return (
    <DataCard title={t('local-backup.restore.title')}>
      <div className="page-stack">
        {capabilityState.status === 'loading' ? (
          <LoadingState label={t('local-backup.loading')} />
        ) : null}
        {capabilityState.status === 'forbidden' ? (
          <ErrorState
            description={capabilityState.message}
            title={t('local-backup.restore.capabilityFailed')}
          />
        ) : null}
        {capabilityState.status === 'failed' ? (
          <ErrorState
            description={capabilityState.message}
            title={t('local-backup.restore.capabilityFailed')}
          />
        ) : null}
        {capabilityState.status === 'ready' ? (
          <Alert
            banner
            showIcon
            type={capabilityState.data.executionAvailable ? 'success' : 'warning'}
            title={
              capabilityState.data.executionAvailable
                ? t('local-backup.restore.executionAvailable')
                : t('local-backup.restore.executionUnavailable')
            }
            description={<ReasonText reason={capabilityState.data.reason} />}
          />
        ) : null}
        {precheckState.status === 'running' ? (
          <LoadingState label={t('local-backup.restore.prechecking')} />
        ) : null}
      </div>
    </DataCard>
  );
}

function PrecheckResultCard({
  result,
  acceptState,
  canExecute,
  executeState,
  onAccept,
  onExecute,
}: {
  result: LocalRestorePrecheckResult;
  acceptState: ReturnType<typeof useRestoreAcceptance>['state'];
  canExecute: boolean;
  executeState: ActionState<LocalRestoreExecution>;
  onAccept: (restoreId: string) => void;
  onExecute: (restoreId: string) => void;
}) {
  const { t } = useI18n();
  const passed = result.outcome === 'PASSED';

  return (
    <DataCard title={t('local-backup.restore.precheckTitle')}>
      <div className="page-stack">
        <Alert
          banner
          showIcon
          type={passed ? 'success' : 'warning'}
          title={
            passed
              ? t('local-backup.restore.precheckPassed')
              : t('local-backup.restore.precheckRejected')
          }
        />
        <Descriptions
          bordered
          column={{ lg: 3, md: 2, sm: 1, xs: 1 }}
          items={[
            {
              key: 'restoreId',
              label: t('local-backup.field.restoreId'),
              children: <code>{result.restoreId}</code>,
            },
            {
              key: 'targetBackupId',
              label: t('local-backup.field.backupId'),
              children: <code>{result.targetBackupId}</code>,
            },
            {
              key: 'targetOrganizationId',
              label: t('local-backup.auto.organization'),
              children: result.targetOrganizationId,
            },
            {
              key: 'targetInstallationId',
              label: t('local-backup.field.installationId'),
              children: result.targetInstallationId ?? t('local-backup.value.dash'),
            },
            {
              key: 'checkedAt',
              label: t('local-backup.field.checkedAt'),
              children: formatDateTimeText(result.checkedAt),
            },
            {
              key: 'protectionBackupId',
              label: t('local-backup.field.protectionBackupId'),
              children: result.protectionBackupId ? (
                <code>{result.protectionBackupId}</code>
              ) : (
                t('local-backup.value.dash')
              ),
            },
            {
              key: 'packageReadable',
              label: t('local-backup.field.packageReadable'),
              children: result.packageReadable
                ? t('local-backup.value.yes')
                : t('local-backup.value.no'),
            },
            {
              key: 'fileCount',
              label: t('local-backup.field.fileCount'),
              children: result.fileCount ?? t('local-backup.value.dash'),
            },
            {
              key: 'verifiedFileCount',
              label: t('local-backup.field.verifiedFileCount'),
              children: result.verifiedFileCount,
            },
          ]}
        />
        {result.findings.length > 0 ? (
          <div className="page-stack">
            <h4>{t('local-backup.restore.findings')}</h4>
            <ul>
              {result.findings.map((finding) => (
                <li key={`${finding.code}-${finding.message}`}>
                  <strong>{finding.code}</strong> <ReasonText reason={finding.message} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/*
          受理确认（管理员专属）。
          纪律：**受理 ≠ 恢复**——只记录「已被授权确认」的事实，不恢复数据、不冻结写入，
          不把受理显示成恢复成功；预检未通过时不提供受理入口。
        */}
        {passed && canExecute ? (
          <div className="page-stack">
            <SecondaryButton
              loading={acceptState.status === 'running'}
              onClick={() => onAccept(result.restoreId)}
            >
              {t('local-backup.restore.acceptAction')}
            </SecondaryButton>
            {acceptState.status === 'succeeded' ? (
              <Alert
                description={t('local-backup.restore.acceptedNotice')}
                showIcon
                title={t('local-backup.restore.acceptSucceeded')}
                type="success"
              />
            ) : null}
            {acceptState.status === 'forbidden' ? (
              <Alert showIcon title={acceptState.message} type="error" />
            ) : null}
            {acceptState.status === 'failed' ? (
              <Alert showIcon title={acceptState.message} type="error" />
            ) : null}
          </div>
        ) : null}

        {/*
          执行恢复（管理员专属）。
          纪律：**受理 ≠ 恢复**——只有真正执行后才给结论；
          失败或回滚未成功时，设备仍停写停传，必须如实呈现，不得显示为「已恢复」。
        */}
        {passed && canExecute && acceptState.status === 'succeeded' ? (
          <div className="page-stack">
            <SecondaryButton
              loading={executeState.status === 'running'}
              onClick={() => onExecute(result.restoreId)}
            >
              {t('local-backup.restore.executeAction')}
            </SecondaryButton>
            {executeState.status === 'running' ? (
              <LoadingState label={t('local-backup.restore.executing')} />
            ) : null}
            {executeState.status === 'succeeded' ? (
              <RestoreExecutionResult result={executeState.data} />
            ) : null}
            {executeState.status === 'forbidden' ? (
              <Alert showIcon title={executeState.message} type="error" />
            ) : null}
            {executeState.status === 'failed' ? (
              <Alert showIcon title={executeState.message} type="error" />
            ) : null}
          </div>
        ) : null}
      </div>
    </DataCard>
  );
}

/** 恢复执行结果：成功与否、冻结是否解除都如实呈现 */
function RestoreExecutionResult({ result }: { result: LocalRestoreExecution }) {
  const { t } = useI18n();
  const succeeded = result.status === 'SUCCEEDED';
  // 冻结是否解除**以服务端给的 released 为准**（不靠成功与否反推）
  const released = result.released;

  return (
    <div className="page-stack">
      <Alert
        banner
        showIcon
        type={succeeded ? 'success' : 'error'}
        title={
          succeeded
            ? t('local-backup.restore.executeSucceeded')
            : t('local-backup.restore.executeFailedTitle')
        }
        description={
          result.holdRetained
            ? t('local-backup.restore.holdRetained')
            : succeeded && released
              ? t('local-backup.restore.released')
              : succeeded
                ? t('local-backup.restore.holdRetained')
                : undefined
        }
      />
      <Descriptions
        bordered
        column={{ lg: 3, md: 2, sm: 1, xs: 1 }}
        items={[
          {
            key: 'status',
            label: t('local-backup.restore.executeTitle'),
            children: <StatusPill tone={succeeded ? 'ok' : 'critical'}>{result.status}</StatusPill>,
          },
          {
            key: 'restoredRecords',
            label: t('local-backup.field.restoredRecords'),
            children: result.restoredRecords ?? t('local-backup.value.dash'),
          },
          {
            key: 'restoredOriginals',
            label: t('local-backup.field.restoredOriginals'),
            children: result.restoredOriginals ?? t('local-backup.value.dash'),
          },
          {
            key: 'restoredQueue',
            label: t('local-backup.field.restoredQueue'),
            children: result.restoredQueue ?? t('local-backup.value.dash'),
          },
          {
            key: 'reasonCode',
            label: t('local-backup.field.errorMessage'),
            children: result.reasonCode ? (
              <ReasonText reason={result.reasonCode} />
            ) : (
              t('local-backup.value.dash')
            ),
          },
          {
            key: 'reason',
            label: t('local-backup.restore.reasonTitle'),
            children: result.reason ?? t('local-backup.value.dash'),
          },
        ]}
      />
    </div>
  );
}

/**
 * 云端备份包清单（任务 09 S3／A09-07）。
 *
 * 纪律：云服务未接入时如实呈现「不可用」，**不展示伪造的可用包**；
 * 下载只给字节，不触发恢复（下载权限 ≠ 恢复权限）。
 */
function CloudPackagesSection({
  state,
  downloadState,
  onDownload,
}: {
  state: ReturnType<typeof useLocalBackupCloudPackages>['state'];
  downloadState: ActionState<LocalBackupCloudPackageDownload>;
  onDownload: (packageId: string) => void;
}) {
  const { t } = useI18n();

  if (state.status === 'loading') {
    return (
      <DataCard title={t('local-backup.cloud.title')}>
        <LoadingState label={t('local-backup.loading')} />
      </DataCard>
    );
  }

  if (state.status === 'forbidden') {
    return (
      <DataCard title={t('local-backup.cloud.title')}>
        <ErrorState description={state.message} title={t('local-backup.error.forbiddenTitle')} />
      </DataCard>
    );
  }

  if (state.status === 'failed') {
    return (
      <DataCard title={t('local-backup.cloud.title')}>
        <div className="page-stack">
          <ErrorState description={state.message} title={t('local-backup.cloud.loadFailed')} />
          <Alert showIcon title={t('local-backup.cloud.unavailable')} type="warning" />
        </div>
      </DataCard>
    );
  }

  if (state.data.packages.length === 0) {
    return (
      <DataCard title={t('local-backup.cloud.title')}>
        <EmptyState title={t('local-backup.cloud.empty')} />
      </DataCard>
    );
  }

  const columns: ColumnsType<LocalBackupCloudPackage> = [
    {
      key: 'packageId',
      title: t('local-backup.field.packageId'),
      render: (_, item) => <code>{item.packageId}</code>,
    },
    {
      key: 'createdAt',
      title: t('local-backup.field.createdAt'),
      render: (_, item) =>
        item.createdAt ? formatDateTimeText(item.createdAt) : t('local-backup.value.dash'),
    },
    {
      key: 'byteSize',
      title: t('local-backup.field.byteSize'),
      render: (_, item) =>
        item.byteSize === null
          ? t('local-backup.value.dash')
          : `${item.byteSize} ${t('local-backup.units.bytes')}`,
    },
    {
      key: 'checksum',
      title: t('local-backup.field.checksum'),
      render: (_, item) =>
        item.checksumSha256 ? `${item.checksumSha256.slice(0, 12)}…` : t('local-backup.value.dash'),
    },
    {
      key: 'actions',
      title: t('local-backup.field.actions'),
      render: (_, item) => (
        <SecondaryButton
          loading={downloadState.status === 'running'}
          onClick={() => onDownload(item.packageId)}
        >
          {downloadState.status === 'running'
            ? t('local-backup.cloud.downloading')
            : t('local-backup.cloud.downloadAction')}
        </SecondaryButton>
      ),
    },
  ];

  return (
    <DataCard title={t('local-backup.cloud.title')}>
      <div className="page-stack">
        {downloadState.status === 'succeeded' && downloadState.data.ok ? (
          <Alert showIcon title={t('local-backup.cloud.downloaded')} type="success" />
        ) : null}
        {downloadState.status === 'succeeded' && !downloadState.data.ok ? (
          <Alert
            description={downloadState.data.reason ?? undefined}
            showIcon
            title={t('local-backup.cloud.downloadFailed')}
            type="error"
          />
        ) : null}
        {downloadState.status === 'failed' ? (
          <Alert showIcon title={downloadState.message} type="error" />
        ) : null}
        <Table<LocalBackupCloudPackage>
          columns={columns}
          dataSource={state.data.packages}
          locale={{ emptyText: t('local-backup.cloud.empty') }}
          pagination={false}
          rowKey="packageId"
          scroll={{ x: 720 }}
          size="small"
        />
      </div>
    </DataCard>
  );
}
