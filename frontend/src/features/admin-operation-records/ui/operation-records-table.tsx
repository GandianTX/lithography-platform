// src/features/admin-operation-records/ui/operation-records-table.tsx

import type { TableColumnsType } from 'antd';
import { Table, Tooltip } from 'antd';

import type { MessageKey } from '@/shared/i18n';
import { useI18n } from '@/shared/i18n';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { StatusPill } from '@/shared/ui/status-pill';

import type {
  OperationRecordDetail,
  OperationRecordItem,
  OperationRecordResult,
} from '../infrastructure/admin-operation-records.types';

/**
 * 关键操作记录七列只读表（任务 10 S3.1，页面 V6.5 §14.1）。
 *
 * - 列：时间／操作者／所属公司／操作类型／目标／实际结果／必要说明；
 * - 只读：无操作列、无行选择、无链接——本页没有任何写入口；
 * - 文案全部走 i18n；`detail` 白名单摘要按存在字段拼装，空摘要显示「—」。
 */

const RESULT_TONE: Record<OperationRecordResult, 'critical' | 'ok' | 'warn'> = {
  SUCCEEDED: 'ok',
  FAILED: 'critical',
  DENIED: 'warn',
};

const SUMMARY_DASH = '—';

/** 已知目标类型的展示名；未知类型原样展示标识，不做兜底翻译。 */
const TARGET_TYPE_LABEL_KEYS: Record<string, MessageKey> = {
  BACKUP_RESTORE_RUN: 'operationRecords.targetType.backupRestoreRun',
  REFERENCE_DOCUMENT: 'operationRecords.targetType.referenceDocument',
};

type SummaryPart = { key: string; text: string };

function buildSummaryParts(
  detail: OperationRecordDetail | null,
  t: ReturnType<typeof useI18n>['t'],
): SummaryPart[] {
  if (detail === null) {
    return [];
  }

  const parts: SummaryPart[] = [];
  if (detail.reason !== null) {
    parts.push({ key: 'reason', text: detail.reason });
  }
  if (detail.stage !== null) {
    parts.push({
      key: 'stage',
      text: t('operationRecords.summary.stage', { stage: detail.stage }),
    });
  }
  if (detail.changedFields !== null && detail.changedFields.length > 0) {
    parts.push({
      key: 'changedFields',
      text: t('operationRecords.summary.changedFields', {
        fields: detail.changedFields.join(', '),
      }),
    });
  }
  if (detail.attemptNo !== null && detail.attemptNo > 1) {
    parts.push({
      key: 'attemptNo',
      text: t('operationRecords.summary.attempt', { attemptNo: detail.attemptNo }),
    });
  }
  if (detail.beforeOrganizationName !== null && detail.afterOrganizationName !== null) {
    parts.push({
      key: 'organizationChange',
      text: t('operationRecords.summary.organizationChange', {
        before: detail.beforeOrganizationName,
        after: detail.afterOrganizationName,
      }),
    });
  } else if (detail.beforeOrganizationName !== null) {
    parts.push({
      key: 'organizationBefore',
      text: t('operationRecords.summary.organizationBefore', {
        name: detail.beforeOrganizationName,
      }),
    });
  } else if (detail.afterOrganizationName !== null) {
    parts.push({
      key: 'organizationAfter',
      text: t('operationRecords.summary.organizationAfter', {
        name: detail.afterOrganizationName,
      }),
    });
  }
  return parts;
}

export function OperationRecordsTable({ items }: { items: OperationRecordItem[] }) {
  const { t } = useI18n();

  const columns: TableColumnsType<OperationRecordItem> = [
    {
      dataIndex: 'occurredAt',
      key: 'occurredAt',
      render: (value: OperationRecordItem['occurredAt']) => (
        <span className="whitespace-nowrap text-xs">{formatDateTimeText(value)}</span>
      ),
      title: t('operationRecords.column.time'),
      width: 150,
    },
    {
      dataIndex: 'actorNickname',
      key: 'actorNickname',
      render: (value: string, record) => (
        <div className="flex min-w-0 flex-col gap-1 text-xs">
          <span className="truncate font-medium">{value}</span>
          <span className="text-text-secondary">
            {t(
              record.actorAdminLevel === 1
                ? 'operationRecords.actorLevel.level1'
                : 'operationRecords.actorLevel.level2',
            )}
          </span>
        </div>
      ),
      title: t('operationRecords.column.actor'),
      width: 140,
    },
    {
      dataIndex: 'organizationName',
      key: 'organizationName',
      render: (value: string | null) => <span className="text-xs">{value ?? SUMMARY_DASH}</span>,
      title: t('operationRecords.column.organization'),
      width: 140,
    },
    {
      dataIndex: 'operation',
      key: 'operation',
      render: (value: OperationRecordItem['operation']) => (
        <span className="text-xs">{t(`operationRecords.operation.${value}`)}</span>
      ),
      title: t('operationRecords.column.operation'),
      width: 120,
    },
    {
      dataIndex: 'targetId',
      key: 'targetId',
      render: (value: string, record) => {
        const targetTypeKey = TARGET_TYPE_LABEL_KEYS[record.targetType];
        const targetTypeLabel = targetTypeKey === undefined ? record.targetType : t(targetTypeKey);
        return (
          <Tooltip title={value}>
            <div className="flex min-w-0 flex-col gap-1 text-xs">
              <span className="truncate">{targetTypeLabel}</span>
              <span className="truncate text-text-tertiary">{value}</span>
            </div>
          </Tooltip>
        );
      },
      title: t('operationRecords.column.target'),
      width: 180,
    },
    {
      dataIndex: 'result',
      key: 'result',
      render: (value: OperationRecordResult) => (
        <StatusPill tone={RESULT_TONE[value]}>{t(`operationRecords.result.${value}`)}</StatusPill>
      ),
      title: t('operationRecords.column.result'),
      width: 100,
    },
    {
      dataIndex: 'detail',
      key: 'detail',
      render: (value: OperationRecordDetail | null) => {
        const parts = buildSummaryParts(value, t);
        if (parts.length === 0) {
          return <span className="text-xs text-text-tertiary">{SUMMARY_DASH}</span>;
        }

        return (
          <div className="flex min-w-0 flex-col gap-1 text-xs">
            {parts.map((part) => (
              <span key={part.key}>{part.text}</span>
            ))}
          </div>
        );
      },
      title: t('operationRecords.column.summary'),
    },
  ];

  return (
    <Table<OperationRecordItem>
      columns={columns}
      dataSource={items}
      pagination={false}
      rowKey="eventId"
      scroll={{ x: 900 }}
    />
  );
}
