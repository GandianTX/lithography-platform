// src/features/sync-conflict/ui/sync-conflict-list.tsx

import { Button, Empty, Space, Spin, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { useI18n } from '@/shared/i18n';

import { useSyncConflictList } from '../application/use-sync-conflict-list';
import type { SyncConflictSummary } from '../infrastructure/sync-conflict.types';

import {
  resolveSyncConflictResourceTypeKey,
  resolveSyncConflictStatusKey,
} from './sync-conflict-labels';

/** 冲突清单（只展示摘要，不拉正文快照） */
export function SyncConflictList({ onOpen }: { onOpen: (conflictId: string) => void }) {
  const { t } = useI18n();
  const { state, goToPage, reload } = useSyncConflictList(true);

  const columns: ColumnsType<SyncConflictSummary> = [
    {
      dataIndex: 'resourceType',
      key: 'resourceType',
      render: (value: string) => <Tag>{t(resolveSyncConflictResourceTypeKey(value))}</Tag>,
      title: t('syncConflict.column.resourceType'),
    },
    {
      dataIndex: 'localVersion',
      key: 'localVersion',
      render: (value: number | null) => (value === null ? '-' : value),
      title: t('syncConflict.column.localVersion'),
    },
    {
      dataIndex: 'cloudVersion',
      key: 'cloudVersion',
      render: (value: number | null) => (value === null ? '-' : value),
      title: t('syncConflict.column.cloudVersion'),
    },
    {
      dataIndex: 'status',
      key: 'status',
      render: (value: string) => (
        <Tag color={value === 'PENDING' ? 'warning' : 'default'}>
          {t(resolveSyncConflictStatusKey(value))}
        </Tag>
      ),
      title: t('syncConflict.column.status'),
    },
    {
      dataIndex: 'conflictReason',
      key: 'conflictReason',
      title: t('syncConflict.column.reason'),
    },
    {
      dataIndex: 'createdAt',
      key: 'createdAt',
      title: t('syncConflict.column.createdAt'),
    },
    {
      key: 'actions',
      render: (_: unknown, row: SyncConflictSummary) => (
        <Button onClick={() => onOpen(row.conflictId)} size="small" type="link">
          {t('syncConflict.action.view')}
        </Button>
      ),
      title: t('syncConflict.column.actions'),
    },
  ];

  if (state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 p-6 text-slate-500">
        <Spin size="small" />
        <span>{t('syncConflict.list.loading')}</span>
      </div>
    );
  }

  if (state.status === 'failed') {
    return (
      <div className="p-6">
        <Empty description={state.message} />
        <div className="mt-3 text-center">
          <Button onClick={reload} size="small">
            {t('syncConflict.list.error')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Table<SyncConflictSummary>
        columns={columns}
        dataSource={state.items}
        locale={{ emptyText: t('syncConflict.list.empty') }}
        pagination={{
          current: state.page,
          onChange: (page: number) => goToPage(page),
          pageSize: state.pageSize,
          showSizeChanger: false,
          total: state.total ?? state.items.length,
        }}
        rowKey="conflictId"
        size="small"
      />
      {state.truncated === true ? (
        <Space size={4}>
          <Tag color="warning">{t('syncConflict.list.truncated')}</Tag>
        </Space>
      ) : null}
    </div>
  );
}
