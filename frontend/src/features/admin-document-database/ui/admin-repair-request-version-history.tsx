// src/features/admin-document-database/ui/admin-repair-request-version-history.tsx

/**
 * 管理员「版本与修订历史」DataCard（任务 04）。
 *
 * - 四列：版本、时间、操作者、原因；新版本在前，操作为「查看版本」「对比上一版」；
 * - 只读弹窗展示服务端返回的 before/after 快照与差异，不拼接当前工单；
 * - 不可比时只展示服务端 incomparableReason，不提供回滚/恢复入口；
 * - 旧记录缺少可比快照时，对比入口禁用并提示。
 */

import { useMemo, useState } from 'react';
import type { TableColumnsType } from 'antd';
import { Alert, Button, Modal, Spin, Table, Tag, Tooltip } from 'antd';

import { type MessageKey, useI18n } from '@/shared/i18n';
import { DataCard } from '@/shared/ui/data-card';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import {
  describePhaseCode,
  describeResetResult,
  describeStepResult,
} from '@/shared/ui/maintenance-record-editor/model';

import { useAdminRepairRevisionDetail } from '../application/use-admin-repair-revision-detail';
import type {
  AdminRepairRevision,
  AdminRepairRevisionSnapshot,
  AdminRevisionPanel,
  AdminRevisionStep,
} from '../infrastructure/admin-document-database.types';

type RevisionSelection = { revisionNo: number; mode: 'view' | 'compare' };

const FIELD_DEFINITIONS: Array<{
  key: keyof Pick<
    AdminRepairRevisionSnapshot,
    | 'contentMd'
    | 'handlingResult'
    | 'handlingStatus'
    | 'closureReason'
    | 'maintenanceDate'
    | 'maintenanceEngineerName'
    | 'resetResult'
    | 'supplementaryNote'
    | 'maintenanceAttachmentFileId'
  >;
  labelKey: MessageKey;
  multiline?: boolean;
}> = [
  { key: 'contentMd', labelKey: 'adminRepairRequest.versionHistory.field.contentMd', multiline: true },
  { key: 'handlingResult', labelKey: 'adminRepairRequest.versionHistory.field.handlingResult' },
  { key: 'handlingStatus', labelKey: 'adminRepairRequest.versionHistory.field.handlingStatus' },
  { key: 'closureReason', labelKey: 'adminRepairRequest.versionHistory.field.closureReason' },
  { key: 'maintenanceDate', labelKey: 'adminRepairRequest.versionHistory.field.maintenanceDate' },
  {
    key: 'maintenanceEngineerName',
    labelKey: 'adminRepairRequest.versionHistory.field.engineerName',
  },
  { key: 'resetResult', labelKey: 'adminRepairRequest.versionHistory.field.resetResult' },
  {
    key: 'supplementaryNote',
    labelKey: 'adminRepairRequest.versionHistory.field.supplementaryNote',
    multiline: true,
  },
  {
    key: 'maintenanceAttachmentFileId',
    labelKey: 'adminRepairRequest.versionHistory.field.attachment',
  },
];

function textOf(value: string | null | undefined): string {
  return value !== null && value !== undefined && value !== '' ? value : '';
}

function sameStepContent(left: AdminRevisionStep, right: AdminRevisionStep): boolean {
  return (
    left.errorCode === right.errorCode &&
    left.partName === right.partName &&
    left.actionText === right.actionText &&
    left.resultCode === right.resultCode
  );
}

function samePanelContent(left: AdminRevisionPanel, right: AdminRevisionPanel): boolean {
  return (
    left.panelType === right.panelType &&
    left.stepId === right.stepId &&
    left.phaseCode === right.phaseCode &&
    left.mainError === right.mainError &&
    left.unitError === right.unitError &&
    left.source === right.source &&
    left.errorType === right.errorType &&
    left.gpibStatus === right.gpibStatus &&
    left.faultStatus === right.faultStatus &&
    left.description === right.description &&
    left.action === right.action
  );
}

type StepChangeKind = 'added' | 'removed' | 'moved' | 'changed';
type PanelChangeKind = 'added' | 'removed' | 'changed';

function diffSteps(
  before: AdminRevisionStep[],
  after: AdminRevisionStep[],
): Array<{ kind: StepChangeKind; step: AdminRevisionStep }> {
  const beforeById = new Map(before.map((step) => [step.id, step]));
  const afterById = new Map(after.map((step) => [step.id, step]));
  const changes: Array<{ kind: StepChangeKind; step: AdminRevisionStep }> = [];

  for (const step of before) {
    if (!afterById.has(step.id)) {
      changes.push({ kind: 'removed', step });
    }
  }
  for (const step of after) {
    const previous = beforeById.get(step.id);
    if (!previous) {
      changes.push({ kind: 'added', step });
      continue;
    }
    if (previous.stepNo !== step.stepNo) {
      changes.push({ kind: 'moved', step });
    }
    if (!sameStepContent(previous, step)) {
      changes.push({ kind: 'changed', step });
    }
  }
  return changes;
}

function diffPanels(
  before: AdminRevisionPanel[],
  after: AdminRevisionPanel[],
): Array<{ kind: PanelChangeKind; panel: AdminRevisionPanel }> {
  const beforeById = new Map(before.map((panel) => [panel.id, panel]));
  const afterById = new Map(after.map((panel) => [panel.id, panel]));
  const changes: Array<{ kind: PanelChangeKind; panel: AdminRevisionPanel }> = [];

  for (const panel of before) {
    if (!afterById.has(panel.id)) {
      changes.push({ kind: 'removed', panel });
    }
  }
  for (const panel of after) {
    const previous = beforeById.get(panel.id);
    if (!previous) {
      changes.push({ kind: 'added', panel });
    } else if (!samePanelContent(previous, panel)) {
      changes.push({ kind: 'changed', panel });
    }
  }
  return changes;
}

function statusTone(kind: StepChangeKind | PanelChangeKind): string {
  switch (kind) {
    case 'added':
      return 'green';
    case 'removed':
      return 'red';
    case 'moved':
      return 'blue';
    case 'changed':
      return 'orange';
  }
}

function statusLabelKey(kind: StepChangeKind | PanelChangeKind): MessageKey {
  switch (kind) {
    case 'added':
      return 'adminRepairRequest.versionHistory.added';
    case 'removed':
      return 'adminRepairRequest.versionHistory.removed';
    case 'moved':
      return 'adminRepairRequest.versionHistory.moved';
    case 'changed':
      return 'adminRepairRequest.versionHistory.changed';
  }
}

function SnapshotView({
  attachmentFileId,
  onDownloadAttachment,
  snapshot,
  title,
}: {
  snapshot: AdminRepairRevisionSnapshot;
  title: string;
  attachmentFileId: string | null;
  onDownloadAttachment: (fileId: string) => Promise<{ ok: boolean; message?: string }>;
}) {
  const { t } = useI18n();
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleDownload = async () => {
    if (attachmentFileId === null) return;
    setDownloadError(null);
    const result = await onDownloadAttachment(attachmentFileId);
    if (!result.ok) {
      setDownloadError(result.message ?? t('adminRepairRequest.versionHistory.downloadFailed'));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <h5 className="m-0 font-medium text-sm">{title}</h5>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {FIELD_DEFINITIONS.map((field) => {
          const raw = snapshot[field.key];
          const value =
            field.key === 'resetResult'
              ? describeResetResult(raw as string | null, t)
              : textOf(raw as string | null);
          return (
            <div
              className={field.multiline ? 'sm:col-span-2' : ''}
              key={String(field.key)}
            >
              <div className="text-text-secondary text-xs">{t(field.labelKey)}</div>
              <div className="text-sm whitespace-pre-wrap">
                {value === '' ? t('adminRepairRequest.versionHistory.value.empty') : value}
              </div>
            </div>
          );
        })}
        {attachmentFileId ? (
          <div className="sm:col-span-2">
            <Button onClick={() => void handleDownload()} size="small">
              {t('adminRepairRequest.versionHistory.downloadAttachment')}
            </Button>
          </div>
        ) : null}
      </div>
      {downloadError ? <Alert showIcon title={downloadError} type="error" /> : null}

      <div>
        <div className="mb-2 font-medium text-sm">
          {t('adminRepairRequest.versionHistory.steps')}
        </div>
        {snapshot.steps.length === 0 ? (
          <div className="text-sm text-text-secondary">
            {t('adminRepairRequest.versionHistory.noStepChanges')}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {snapshot.steps.map((step) => (
              <div
                className="rounded-lg border border-[var(--panel-border)] p-3"
                key={step.id}
              >
                <div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">#{step.stepNo}</span>
                  <Tag>{describeStepResult(step.resultCode, t)}</Tag>
                  {step.errorCode ? <span>{step.errorCode}</span> : null}
                  {step.partName ? <span>{step.partName}</span> : null}
                </div>
                <div className="text-sm whitespace-pre-wrap">{step.actionText}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 font-medium text-sm">
          {t('adminRepairRequest.versionHistory.panels')}
        </div>
        {snapshot.panels.length === 0 ? (
          <div className="text-sm text-text-secondary">
            {t('adminRepairRequest.versionHistory.noPanelChanges')}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {snapshot.panels.map((panel) => (
              <div
                className="rounded-lg border border-[var(--panel-border)] p-3"
                key={panel.id}
              >
                <div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
                  <Tag>{panel.panelType}</Tag>
                  <span>{describePhaseCode(panel.phaseCode, t)}</span>
                </div>
                <div className="text-sm whitespace-pre-wrap">{panel.description}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DiffView({
  after,
  before,
  t,
}: {
  before: AdminRepairRevisionSnapshot;
  after: AdminRepairRevisionSnapshot;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const fieldChanges = FIELD_DEFINITIONS.flatMap((field) => {
    const beforeValue = textOf(before[field.key] as string | null);
    const afterValue = textOf(after[field.key] as string | null);
    if (beforeValue === afterValue) {
      return [];
    }
    return [{ field, beforeValue, afterValue }];
  });
  const stepChanges = diffSteps(before.steps, after.steps);
  const panelChanges = diffPanels(before.panels, after.panels);
  const hasChanges =
    fieldChanges.length > 0 || stepChanges.length > 0 || panelChanges.length > 0;

  if (!hasChanges) {
    return (
      <div className="text-sm text-text-secondary">
        {t('adminRepairRequest.versionHistory.noDifferences')}
      </div>
    );
  }

  const renderValue = (value: string, fieldKey: keyof AdminRepairRevisionSnapshot) =>
    value === ''
      ? t('adminRepairRequest.versionHistory.value.empty')
      : fieldKey === 'resetResult'
        ? describeResetResult(value, t)
        : value;

  return (
    <div className="flex flex-col gap-4">
      {fieldChanges.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h5 className="m-0 font-medium text-sm">
            {t('adminRepairRequest.versionHistory.fieldChanges')}
          </h5>
          {fieldChanges.map(({ field, beforeValue, afterValue }) => (
            <div
              className="rounded-lg border border-[var(--panel-border)] p-3"
              key={String(field.key)}
            >
              <div className="mb-1 font-medium text-sm">{t(field.labelKey)}</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <div className="text-text-secondary text-xs">
                    {t('adminRepairRequest.versionHistory.before')}
                  </div>
                  <div className={`text-sm ${field.multiline ? 'whitespace-pre-wrap' : ''}`}>
                    {renderValue(beforeValue, field.key)}
                  </div>
                </div>
                <div>
                  <div className="text-text-secondary text-xs">
                    {t('adminRepairRequest.versionHistory.after')}
                  </div>
                  <div className={`text-sm ${field.multiline ? 'whitespace-pre-wrap' : ''}`}>
                    {renderValue(afterValue, field.key)}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div>
        <div className="mb-2 font-medium text-sm">
          {t('adminRepairRequest.versionHistory.steps')}
        </div>
        {stepChanges.length === 0 ? (
          <div className="text-sm text-text-secondary">
            {t('adminRepairRequest.versionHistory.noStepChanges')}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {stepChanges.map(({ kind, step }, index) => (
              <div
                className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--panel-border)] p-2 text-sm"
                key={`${kind}:${step.id}:${index}`}
              >
                <Tag color={statusTone(kind)}>{t(statusLabelKey(kind))}</Tag>
                <span className="font-medium">#{step.stepNo}</span>
                <span>{step.actionText}</span>
                <Tag>{describeStepResult(step.resultCode, t)}</Tag>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 font-medium text-sm">
          {t('adminRepairRequest.versionHistory.panels')}
        </div>
        {panelChanges.length === 0 ? (
          <div className="text-sm text-text-secondary">
            {t('adminRepairRequest.versionHistory.noPanelChanges')}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {panelChanges.map(({ kind, panel }, index) => (
              <div
                className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--panel-border)] p-2 text-sm"
                key={`${kind}:${panel.id}:${index}`}
              >
                <Tag color={statusTone(kind)}>{t(statusLabelKey(kind))}</Tag>
                <Tag>{panel.panelType}</Tag>
                <span>{describePhaseCode(panel.phaseCode, t)}</span>
                <span className="whitespace-pre-wrap">{panel.description}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function AdminRepairRequestVersionHistory({
  onDownloadAttachment,
  requestId,
  revisions,
}: {
  requestId: number;
  revisions: AdminRepairRevision[];
  onDownloadAttachment: (fileId: string) => Promise<{ ok: boolean; message?: string }>;
}) {
  const { t } = useI18n();
  const [selection, setSelection] = useState<RevisionSelection | null>(null);
  const { state, retry } = useAdminRepairRevisionDetail(
    requestId,
    selection?.revisionNo ?? null,
  );

  const sortedRevisions = useMemo(
    () => [...revisions].sort((left, right) => right.revisionNo - left.revisionNo),
    [revisions],
  );

  const columns: TableColumnsType<AdminRepairRevision> = [
    {
      key: 'version',
      render: (_, revision) => (
        <Tag>{t('adminRepairRequest.versionHistory.versionLabel', { version: revision.revisionNo })}</Tag>
      ),
      title: t('adminRepairRequest.versionHistory.col.version'),
      width: 100,
    },
    {
      dataIndex: 'createdAt',
      key: 'time',
      render: (value: string) => formatDateTimeText(value),
      title: t('adminRepairRequest.versionHistory.col.time'),
      width: 180,
    },
    {
      dataIndex: 'actorNickname',
      key: 'actor',
      title: t('adminRepairRequest.versionHistory.col.actor'),
      width: 140,
    },
    {
      dataIndex: 'reason',
      key: 'reason',
      render: (value: string) => value || '—',
      title: t('adminRepairRequest.versionHistory.col.reason'),
    },
    {
      key: 'actions',
      render: (_, revision) => {
        const comparable = revision.hasComparableSnapshot !== false;
        return (
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => setSelection({ revisionNo: revision.revisionNo, mode: 'view' })}
              size="small"
            >
              {t('adminRepairRequest.versionHistory.view')}
            </Button>
            {comparable ? (
              <Button
                onClick={() =>
                  setSelection({ revisionNo: revision.revisionNo, mode: 'compare' })
                }
                size="small"
              >
                {t('adminRepairRequest.versionHistory.compare')}
              </Button>
            ) : (
              <Tooltip title={t('adminRepairRequest.versionHistory.compareUnavailable')}>
                <Button disabled size="small">
                  {t('adminRepairRequest.versionHistory.compare')}
                </Button>
              </Tooltip>
            )}
          </div>
        );
      },
      title: t('adminRepairRequest.versionHistory.col.actions'),
      width: 220,
    },
  ];

  const modalTitle = selection
    ? selection.mode === 'view'
      ? t('adminRepairRequest.versionHistory.detailTitle', { version: selection.revisionNo })
      : t('adminRepairRequest.versionHistory.compareTitle', {
          from:
            state.status === 'ready'
              ? state.detail.previousVersion
              : Math.max(selection.revisionNo - 1, 0),
          to: selection.revisionNo,
        })
    : '';

  const incomparable =
    state.status === 'ready' && state.detail.comparable === false;
  const hasBothSnapshots =
    state.status === 'ready' &&
    state.detail.before !== null &&
    state.detail.after !== null;

  return (
    <DataCard
      extra={
        <span className="text-text-secondary text-xs">
          {t('adminRepairRequest.versionHistory.noRollback')}
        </span>
      }
      title={t('adminRepairRequest.versionHistoryCard')}
    >
      {sortedRevisions.length === 0 ? (
        <div className="text-sm text-text-secondary">
          {t('adminRepairRequest.versionHistory.empty')}
        </div>
      ) : (
        <Table
          columns={columns}
          dataSource={sortedRevisions}
          pagination={false}
          rowKey="revisionNo"
          scroll={{ x: 760 }}
          size="small"
        />
      )}

      <Modal
        destroyOnHidden
        footer={
          <Button onClick={() => setSelection(null)}>
            {t('adminRepairRequest.versionHistory.close')}
          </Button>
        }
        onCancel={() => setSelection(null)}
        open={selection !== null}
        title={modalTitle}
        width={960}
      >
        {state.status === 'loading' ? (
          <div className="flex justify-center py-10">
            <Spin tip={t('adminRepairRequest.versionHistory.loading')} />
          </div>
        ) : null}

        {state.status === 'failed' ? (
          <Alert
            action={
              <Button onClick={retry} size="small">
                {t('adminRepairRequest.versionHistory.retry')}
              </Button>
            }
            showIcon
            title={state.message}
            type="error"
          />
        ) : null}

        {state.status === 'ready' ? (
          <div className="flex flex-col gap-4">
            {incomparable ? (
              <Alert
                description={
                  state.detail.incomparableReason ??
                  t('adminRepairRequest.versionHistory.incomparableFallback')
                }
                showIcon
                title={t('adminRepairRequest.versionHistory.incomparableTitle')}
                type="warning"
              />
            ) : null}

            {selection?.mode === 'view' ? (
              state.detail.after !== null ? (
                <SnapshotView
                  attachmentFileId={state.detail.after.maintenanceAttachmentFileId}
                  onDownloadAttachment={onDownloadAttachment}
                  snapshot={state.detail.after}
                  title={t('adminRepairRequest.versionHistory.after')}
                />
              ) : state.detail.before !== null ? (
                <SnapshotView
                  attachmentFileId={state.detail.before.maintenanceAttachmentFileId}
                  onDownloadAttachment={onDownloadAttachment}
                  snapshot={state.detail.before}
                  title={t('adminRepairRequest.versionHistory.before')}
                />
              ) : (
                <div className="text-sm text-text-secondary">
                  {t('adminRepairRequest.versionHistory.noSnapshot')}
                </div>
              )
            ) : !incomparable && hasBothSnapshots ? (
              <DiffView
                after={state.detail.after!}
                before={state.detail.before!}
                t={t}
              />
            ) : null}

            <div className="text-text-secondary text-xs">
              {t('adminRepairRequest.versionHistory.noRollback')}
            </div>
          </div>
        ) : null}
      </Modal>
    </DataCard>
  );
}
