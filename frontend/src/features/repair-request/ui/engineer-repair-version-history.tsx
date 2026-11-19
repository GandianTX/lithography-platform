// src/features/repair-request/ui/engineer-repair-version-history.tsx

/**
 * 工程师详情底部「版本与修订历史」（任务 04 本轮调整）。
 *
 * - 四列：版本 / 时间、操作者、操作 / 原因、查看；最新在前；
 * - 仅调用工程师侧只读查询，不调用管理员接口，不提供回滚；
 * - 查看版本与对比上一版均只展示服务端返回的工程师可见维修快照；
 * - 缺少可比快照或无可见维修差异时禁用对比并提示原因；
 * - 历史查询失败只在区块内提示，不影响工单详情与当前维修记录。
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

import {
  useEngineerRepairRevisionDetail,
  useEngineerRepairRevisionHistory,
} from '../application/use-engineer-repair-revision-history';
import type {
  EngineerRepairMaintenanceFaultPanel,
  EngineerRepairMaintenanceStep,
  EngineerRepairRevisionCompareUnavailableReason,
  EngineerRepairRevisionSnapshot,
} from '../infrastructure/engineer-repair-request.types';

type RevisionSelection = { revisionNo: number; mode: 'view' | 'compare' };

const FIELD_DEFINITIONS: Array<{
  key: keyof Pick<
    EngineerRepairRevisionSnapshot,
    'maintenanceDate' | 'engineerName' | 'resetResult' | 'supplementaryNote'
  >;
  labelKey: MessageKey;
  multiline?: boolean;
}> = [
  { key: 'maintenanceDate', labelKey: 'engineerRepairHistory.field.maintenanceDate' },
  { key: 'engineerName', labelKey: 'engineerRepairHistory.field.engineerName' },
  { key: 'resetResult', labelKey: 'engineerRepairHistory.field.resetResult' },
  {
    key: 'supplementaryNote',
    labelKey: 'engineerRepairHistory.field.supplementaryNote',
    multiline: true,
  },
];

function textOf(value: string | null | undefined): string {
  return value !== null && value !== undefined && value !== '' ? value : '';
}

function sameStepContent(
  left: EngineerRepairMaintenanceStep,
  right: EngineerRepairMaintenanceStep,
): boolean {
  return (
    left.errorCode === right.errorCode &&
    left.partName === right.partName &&
    left.actionText === right.actionText &&
    left.resultCode === right.resultCode
  );
}

function samePanelContent(
  left: EngineerRepairMaintenanceFaultPanel,
  right: EngineerRepairMaintenanceFaultPanel,
): boolean {
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
  before: EngineerRepairMaintenanceStep[],
  after: EngineerRepairMaintenanceStep[],
): Array<{ kind: StepChangeKind; step: EngineerRepairMaintenanceStep }> {
  const beforeById = new Map(before.map((step) => [step.id, step]));
  const afterById = new Map(after.map((step) => [step.id, step]));
  const changes: Array<{ kind: StepChangeKind; step: EngineerRepairMaintenanceStep }> = [];

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
  before: EngineerRepairMaintenanceFaultPanel[],
  after: EngineerRepairMaintenanceFaultPanel[],
): Array<{ kind: PanelChangeKind; panel: EngineerRepairMaintenanceFaultPanel }> {
  const beforeById = new Map(before.map((panel) => [panel.id, panel]));
  const afterById = new Map(after.map((panel) => [panel.id, panel]));
  const changes: Array<{ kind: PanelChangeKind; panel: EngineerRepairMaintenanceFaultPanel }> = [];

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
      return 'engineerRepairHistory.added';
    case 'removed':
      return 'engineerRepairHistory.removed';
    case 'moved':
      return 'engineerRepairHistory.moved';
    case 'changed':
      return 'engineerRepairHistory.changed';
  }
}

function compareUnavailableLabelKey(
  reason: EngineerRepairRevisionCompareUnavailableReason,
): MessageKey {
  return reason === 'NO_VISIBLE_MAINTENANCE_CHANGE'
    ? 'engineerRepairHistory.compareUnavailable'
    : 'engineerRepairHistory.compareUnavailableNoSnapshot';
}

function SnapshotView({
  snapshot,
  title,
}: {
  snapshot: EngineerRepairRevisionSnapshot;
  title: string;
}) {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-4">
      <h5 className="m-0 font-medium text-sm">{title}</h5>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {FIELD_DEFINITIONS.map((field) => {
          const raw = snapshot[field.key];
          const value = field.key === 'resetResult' ? describeResetResult(raw, t) : textOf(raw);
          return (
            <div className={field.multiline ? 'sm:col-span-2' : ''} key={String(field.key)}>
              <div className="text-text-secondary text-xs">{t(field.labelKey)}</div>
              <div className="text-sm whitespace-pre-wrap">
                {value === '' ? t('engineerRepairHistory.value.empty') : value}
              </div>
            </div>
          );
        })}
      </div>

      <div>
        <div className="mb-2 font-medium text-sm">{t('engineerRepairHistory.steps')}</div>
        {snapshot.steps.length === 0 ? (
          <div className="text-sm text-text-secondary">
            {t('engineerRepairHistory.noStepChanges')}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {snapshot.steps.map((step) => (
              <div className="rounded-lg border border-[var(--panel-border)] p-3" key={step.id}>
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
        <div className="mb-2 font-medium text-sm">{t('engineerRepairHistory.panels')}</div>
        {snapshot.panels.length === 0 ? (
          <div className="text-sm text-text-secondary">
            {t('engineerRepairHistory.noPanelChanges')}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {snapshot.panels.map((panel) => (
              <div className="rounded-lg border border-[var(--panel-border)] p-3" key={panel.id}>
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
  before: EngineerRepairRevisionSnapshot;
  after: EngineerRepairRevisionSnapshot;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const fieldChanges = FIELD_DEFINITIONS.flatMap((field) => {
    const beforeValue = textOf(before[field.key]);
    const afterValue = textOf(after[field.key]);
    if (beforeValue === afterValue) {
      return [];
    }
    return [{ field, beforeValue, afterValue }];
  });
  const stepChanges = diffSteps(before.steps, after.steps);
  const panelChanges = diffPanels(before.panels, after.panels);
  const hasChanges = fieldChanges.length > 0 || stepChanges.length > 0 || panelChanges.length > 0;

  if (!hasChanges) {
    return (
      <div className="text-sm text-text-secondary">{t('engineerRepairHistory.noDifferences')}</div>
    );
  }

  const renderValue = (value: string, fieldKey: keyof EngineerRepairRevisionSnapshot) =>
    value === ''
      ? t('engineerRepairHistory.value.empty')
      : fieldKey === 'resetResult'
        ? describeResetResult(value, t)
        : value;

  return (
    <div className="flex flex-col gap-4">
      {fieldChanges.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h5 className="m-0 font-medium text-sm">{t('engineerRepairHistory.fieldChanges')}</h5>
          {fieldChanges.map(({ field, beforeValue, afterValue }) => (
            <div
              className="rounded-lg border border-[var(--panel-border)] p-3"
              key={String(field.key)}
            >
              <div className="mb-1 font-medium text-sm">{t(field.labelKey)}</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <div className="text-text-secondary text-xs">
                    {t('engineerRepairHistory.before')}
                  </div>
                  <div className={`text-sm ${field.multiline ? 'whitespace-pre-wrap' : ''}`}>
                    {renderValue(beforeValue, field.key)}
                  </div>
                </div>
                <div>
                  <div className="text-text-secondary text-xs">
                    {t('engineerRepairHistory.after')}
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
        <div className="mb-2 font-medium text-sm">{t('engineerRepairHistory.steps')}</div>
        {stepChanges.length === 0 ? (
          <div className="text-sm text-text-secondary">
            {t('engineerRepairHistory.noStepChanges')}
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
        <div className="mb-2 font-medium text-sm">{t('engineerRepairHistory.panels')}</div>
        {panelChanges.length === 0 ? (
          <div className="text-sm text-text-secondary">
            {t('engineerRepairHistory.noPanelChanges')}
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

function compareUnavailableMessageKey(detail: {
  hasComparableSnapshot: boolean;
  hasVisibleMaintenanceChange: boolean;
}): MessageKey {
  if (!detail.hasComparableSnapshot) {
    return 'engineerRepairHistory.incomparableNoSnapshot';
  }
  return 'engineerRepairHistory.incomparableNoChange';
}

export function EngineerRepairVersionHistory({ requestId }: { requestId: number }) {
  const { t } = useI18n();
  const { state: historyState, retry: retryHistory } = useEngineerRepairRevisionHistory(requestId);
  const [selection, setSelection] = useState<RevisionSelection | null>(null);
  const { state: detailState, retry: retryDetail } = useEngineerRepairRevisionDetail(
    requestId,
    selection?.revisionNo ?? null,
  );

  const sortedItems = useMemo(
    () =>
      (historyState.status === 'ready' ? [...historyState.items] : []).sort(
        (left, right) => right.revisionNo - left.revisionNo,
      ),
    [historyState],
  );

  const columns: TableColumnsType<(typeof sortedItems)[number]> = [
    {
      key: 'version',
      render: (_, item) => (
        <div className="flex flex-col gap-1">
          <Tag>{t('engineerRepairHistory.versionLabel', { version: item.revisionNo })}</Tag>
          <span className="text-text-secondary text-xs">{formatDateTimeText(item.createdAt)}</span>
        </div>
      ),
      title: t('engineerRepairHistory.col.version'),
      width: 180,
    },
    {
      dataIndex: 'actorNickname',
      key: 'actor',
      title: t('engineerRepairHistory.col.actor'),
      width: 140,
    },
    {
      dataIndex: 'reason',
      key: 'reason',
      render: (value: string) => value || '—',
      title: t('engineerRepairHistory.col.reason'),
    },
    {
      key: 'actions',
      render: (_, item) => {
        const compareAvailable = item.hasComparableSnapshot && item.hasVisibleMaintenanceChange;
        return (
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => setSelection({ revisionNo: item.revisionNo, mode: 'view' })}
              size="small"
            >
              {t('engineerRepairHistory.view')}
            </Button>
            {compareAvailable ? (
              <Button
                onClick={() => setSelection({ revisionNo: item.revisionNo, mode: 'compare' })}
                size="small"
              >
                {t('engineerRepairHistory.compare')}
              </Button>
            ) : (
              <Tooltip
                title={t(
                  compareUnavailableLabelKey(
                    item.compareUnavailableReason ??
                      (item.hasComparableSnapshot
                        ? 'NO_VISIBLE_MAINTENANCE_CHANGE'
                        : 'NO_COMPARABLE_SNAPSHOT'),
                  ),
                )}
              >
                <Button disabled size="small">
                  {t('engineerRepairHistory.compare')}
                </Button>
              </Tooltip>
            )}
          </div>
        );
      },
      title: t('engineerRepairHistory.col.actions'),
      width: 220,
    },
  ];

  const modalTitle = selection
    ? selection.mode === 'view'
      ? t('engineerRepairHistory.detailTitle', { version: selection.revisionNo })
      : t('engineerRepairHistory.compareTitle', {
          from:
            detailState.status === 'ready'
              ? detailState.detail.previousVersion
              : Math.max(selection.revisionNo - 1, 0),
          to: selection.revisionNo,
        })
    : '';

  const incomparable =
    detailState.status === 'ready' &&
    (!detailState.detail.hasComparableSnapshot || !detailState.detail.hasVisibleMaintenanceChange);

  return (
    <DataCard
      extra={
        <span className="text-text-secondary text-xs">{t('engineerRepairHistory.noRollback')}</span>
      }
      title={t('engineerRepairHistory.title')}
    >
      {historyState.status === 'loading' ? (
        <div className="flex justify-center py-6">
          <Spin tip={t('engineerRepairHistory.loading')} />
        </div>
      ) : null}

      {historyState.status === 'failed' ? (
        <Alert
          action={
            <Button onClick={() => void retryHistory()} size="small">
              {t('engineerRepairHistory.retry')}
            </Button>
          }
          showIcon
          title={historyState.message}
          type="error"
        />
      ) : null}

      {historyState.status === 'ready' ? (
        sortedItems.length === 0 ? (
          <div className="text-sm text-text-secondary">{t('engineerRepairHistory.empty')}</div>
        ) : (
          <Table
            columns={columns}
            dataSource={sortedItems}
            pagination={false}
            rowKey="revisionNo"
            scroll={{ x: 760 }}
            size="small"
          />
        )
      ) : null}

      <Modal
        destroyOnHidden
        footer={
          <Button onClick={() => setSelection(null)}>{t('engineerRepairHistory.close')}</Button>
        }
        onCancel={() => setSelection(null)}
        open={selection !== null}
        title={modalTitle}
        width={960}
      >
        {detailState.status === 'loading' ? (
          <div className="flex justify-center py-10">
            <Spin tip={t('engineerRepairHistory.loading')} />
          </div>
        ) : null}

        {detailState.status === 'failed' ? (
          <Alert
            action={
              <Button onClick={() => void retryDetail()} size="small">
                {t('engineerRepairHistory.retry')}
              </Button>
            }
            showIcon
            title={detailState.message}
            type="error"
          />
        ) : null}

        {detailState.status === 'ready' ? (
          <div className="flex flex-col gap-4">
            {incomparable ? (
              <Alert
                description={t(compareUnavailableMessageKey(detailState.detail))}
                showIcon
                title={t('engineerRepairHistory.incomparableTitle')}
                type="warning"
              />
            ) : null}

            {selection?.mode === 'view' ? (
              detailState.detail.after !== null ? (
                <SnapshotView
                  snapshot={detailState.detail.after}
                  title={t('engineerRepairHistory.after')}
                />
              ) : detailState.detail.before !== null ? (
                <SnapshotView
                  snapshot={detailState.detail.before}
                  title={t('engineerRepairHistory.before')}
                />
              ) : (
                <div className="text-sm text-text-secondary">
                  {t('engineerRepairHistory.noSnapshot')}
                </div>
              )
            ) : !incomparable &&
              detailState.detail.before !== null &&
              detailState.detail.after !== null ? (
              <DiffView after={detailState.detail.after} before={detailState.detail.before} t={t} />
            ) : null}

            <div className="text-text-secondary text-xs">
              {t('engineerRepairHistory.noRollback')}
            </div>
          </div>
        ) : null}
      </Modal>
    </DataCard>
  );
}
