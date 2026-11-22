// src/features/sync-conflict/ui/sync-conflict-detail-panel.tsx

import { Alert, Button, Descriptions, Empty, Popconfirm, Space, Spin, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router';

import { useI18n } from '@/shared/i18n';

import { useSyncConflictDetail } from '../application/use-sync-conflict-detail';
import type { SyncConflictDiffEntry } from '../infrastructure/sync-conflict.types';

import {
  resolveSyncConflictDecisionKey,
  resolveSyncConflictDiffKindKey,
  resolveSyncConflictReadOnlyKey,
  resolveSyncConflictResourceTypeKey,
  resolveSyncConflictStatusKey,
} from './sync-conflict-labels';
import { resolveSyncConflictSourcePath } from './sync-conflict-paths';

const DIFF_KIND_COLOR: Record<string, string> = {
  DIFFERENT: 'orange',
  ONLY_CLOUD: 'purple',
  ONLY_LOCAL: 'blue',
};

/**
 * 冲突详情面板：版本、差异、来源页入口与三个裁决动作。
 *
 * 动作可用性口径：
 * - 只读内容（已删除／下架／冻结／结单）**不提供**"使用云端／保留本地"，
 *   并给出受控原因说明——服务端同样会拒绝，前端只是提前把话说清楚；
 * - "稍后处理"任何时候都可用（它不写业务内容）。
 */
export function SyncConflictDetailPanel({ conflictId }: { conflictId: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { state, resolve, resolving } = useSyncConflictDetail(conflictId);

  if (state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 p-6 text-slate-500">
        <Spin size="small" />
        <span>{t('syncConflict.list.loading')}</span>
      </div>
    );
  }

  if (state.status === 'failed') {
    return <Empty description={state.message} />;
  }

  const detail = state.detail;
  const sourcePath = resolveSyncConflictSourcePath({
    resourceType: detail.resourceType,
    sourceRecordId: detail.sourceRecordId,
  });
  const readOnly = detail.sourceReadOnly;
  const diffColumns: ColumnsType<SyncConflictDiffEntry> = [
    { dataIndex: 'path', key: 'path', title: t('syncConflict.detail.diff.column.path') },
    {
      dataIndex: 'kind',
      key: 'kind',
      render: (value: string) => (
        <Tag color={DIFF_KIND_COLOR[value] ?? 'default'}>
          {t(resolveSyncConflictDiffKindKey(value))}
        </Tag>
      ),
    },
    {
      dataIndex: 'localValue',
      key: 'localValue',
      render: (value: string | null) => value ?? '-',
      title: t('syncConflict.detail.diff.column.local'),
    },
    {
      dataIndex: 'cloudValue',
      key: 'cloudValue',
      render: (value: string | null) => value ?? '-',
      title: t('syncConflict.detail.diff.column.cloud'),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Descriptions
        column={2}
        items={[
          {
            key: 'resourceType',
            label: t('syncConflict.column.resourceType'),
            children: t(resolveSyncConflictResourceTypeKey(detail.resourceType)),
          },
          {
            key: 'localVersion',
            label: t('syncConflict.column.localVersion'),
            children: detail.localVersion ?? '-',
          },
          {
            key: 'cloudVersion',
            label: t('syncConflict.column.cloudVersion'),
            children: detail.cloudVersion ?? '-',
          },
          {
            key: 'status',
            label: t('syncConflict.column.status'),
            children: t(resolveSyncConflictStatusKey(detail.status)),
          },
          {
            key: 'decision',
            label: t('syncConflict.column.decision'),
            children:
              detail.decision === null
                ? t('syncConflict.decision.PENDING')
                : t(resolveSyncConflictDecisionKey(detail.decision)),
          },
          {
            key: 'reason',
            label: t('syncConflict.column.reason'),
            children: detail.conflictReason,
          },
        ]}
        size="small"
      />

      {readOnly ? (
        <Alert
          description={
            detail.sourceReadOnlyReason === null
              ? t('syncConflict.action.readOnlyNotice')
              : t(resolveSyncConflictReadOnlyKey(detail.sourceReadOnlyReason))
          }
          showIcon
          title={t('syncConflict.action.readOnlyNotice')}
          type="warning"
        />
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-slate-700">{t('syncConflict.detail.diff')}</h3>
        {detail.diff === null || detail.diff.invalid ? (
          <Alert showIcon title={t('syncConflict.detail.diff.invalid')} type="info" />
        ) : detail.diff.entries.length === 0 ? (
          <Empty
            description={t('syncConflict.detail.diff.empty')}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : (
          <Table<SyncConflictDiffEntry>
            columns={diffColumns}
            dataSource={detail.diff.entries}
            pagination={false}
            rowKey="path"
            size="small"
          />
        )}
        {detail.diff?.truncated === true ? (
          <Tag color="warning">{t('syncConflict.detail.diff.truncated')}</Tag>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-slate-700">
          {t('syncConflict.detail.localSnapshot')}
        </h3>
        <pre className="max-h-48 overflow-auto rounded bg-slate-50 p-2 text-xs">
          {detail.localSnapshot}
        </pre>
        <h3 className="text-sm font-semibold text-slate-700">
          {t('syncConflict.detail.cloudSnapshot')}
        </h3>
        <pre className="max-h-48 overflow-auto rounded bg-slate-50 p-2 text-xs">
          {detail.cloudSnapshot}
        </pre>
      </section>

      <Space wrap>
        {sourcePath === null ? (
          <Button disabled size="small">
            {t('syncConflict.action.sourceUnavailable')}
          </Button>
        ) : (
          <Button onClick={() => void navigate(sourcePath)} size="small">
            {t('syncConflict.action.openSource')}
          </Button>
        )}
        <Popconfirm
          cancelText={t('syncConflict.action.later')}
          okText={t('syncConflict.action.later')}
          onConfirm={() => void resolve('LATER')}
          title={t('syncConflict.action.later')}
        >
          <Button loading={resolving} size="small">
            {t('syncConflict.action.later')}
          </Button>
        </Popconfirm>
        <Popconfirm
          cancelText={t('syncConflict.action.cloud')}
          okText={t('syncConflict.action.cloud')}
          onConfirm={() => void resolve('CLOUD')}
          title={t('syncConflict.action.cloud')}
        >
          <Button disabled={readOnly} loading={resolving} size="small" type="primary">
            {t('syncConflict.action.cloud')}
          </Button>
        </Popconfirm>
        <Popconfirm
          cancelText={t('syncConflict.action.local')}
          okText={t('syncConflict.action.local')}
          onConfirm={() => void resolve('LOCAL')}
          title={t('syncConflict.action.local')}
        >
          <Button disabled={readOnly} loading={resolving} size="small">
            {t('syncConflict.action.local')}
          </Button>
        </Popconfirm>
      </Space>
    </div>
  );
}
