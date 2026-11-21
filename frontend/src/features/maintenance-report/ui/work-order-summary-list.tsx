// src/features/maintenance-report/ui/work-order-summary-list.tsx
//
// 工单维修总结待填写列表：服务端只返回本人接单、已结单、同组织且尚未正式提交的工单。
// 同一工单再次进入即续填同一份草稿（reportId 非空时按钮为「继续核对」）。
// 2026-11-21 需求调整：动作按钮改为「核对工单与评价」，每行新增「来源工单」
// 跳转到任务 04 工程师工单详情页——路径由页面层注入（features 不互相依赖），
// 仍复用 /engineer/repair-requests/:requestId 的既有路由守卫与服务端读侧授权。

import { useEffect, useState } from 'react';
import { Alert, Button, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router';

import { isGraphQLIngressError } from '@/shared/graphql';
import { useI18n } from '@/shared/i18n';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { PageHeader } from '@/shared/ui/page-header';

import type { WorkOrderSummaryCandidate } from '../infrastructure/maintenance-report.types';
import { fetchMyWorkOrderSummaryCandidates } from '../infrastructure/maintenance-report-adapter';

import { WORK_ORDER_SUMMARIES_PATH } from './maintenance-report-editor-page';

const PAGE_SIZE = 20;

export function WorkOrderSummaryList({
  resolveSourceWorkOrderPath,
}: {
  /** 页面层注入：repairRequestId（工单 ID，非报告 ID）→ 任务 04 工程师工单详情路径 */
  resolveSourceWorkOrderPath?: (repairRequestId: number) => string;
} = {}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [items, setItems] = useState<WorkOrderSummaryCandidate[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 入口资格由服务端裁决；列表只读取候选工单，不额外做权限判断
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await fetchMyWorkOrderSummaryCandidates({
          page,
          pageSize: PAGE_SIZE,
        });
        if (cancelled) return;
        setItems(result.items);
        setTotal(result.total ?? null);
        setError(null);
      } catch (loadError) {
        if (cancelled) return;
        setError(
          isGraphQLIngressError(loadError)
            ? loadError.userMessage
            : t('maintenanceReport.loadFailed'),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [page, reloadToken, t]);

  // 2026-11-21 列表对齐 Demo 截图：来源工单 | 设备 | 故障现象 | 结单时间 | 总结状态 | 操作
  // （原「处理结果」列移出列表，处理结果仍可在只读核对页查看；不加新筛选与业务状态）
  const columns: ColumnsType<WorkOrderSummaryCandidate> = [
    {
      title: t('maintenanceReport.summary.sourceWorkOrder'),
      dataIndex: 'requestNo',
      key: 'requestNo',
    },
    {
      title: t('maintenanceReport.field.equipmentModel'),
      key: 'model',
      render: (_value, record) =>
        record.equipmentModelName === null
          ? (record.equipmentModelCode ?? '—')
          : `${record.equipmentModelCode ?? ''} · ${record.equipmentModelName}`,
    },
    {
      title: t('maintenanceReport.column.faultDescription'),
      dataIndex: 'intakeFaultDescription',
      key: 'faultDescription',
      ellipsis: true,
      render: (value: string | null) => (value === null || value.trim().length === 0 ? '—' : value),
    },
    {
      title: t('maintenanceReport.column.closedAt'),
      dataIndex: 'closedAt',
      key: 'closedAt',
      render: (value: string | null) => (value === null ? '—' : formatDateTimeText(value)),
    },
    {
      title: t('maintenanceReport.column.draft'),
      key: 'draft',
      render: (_value, record) =>
        record.reportId === null ? (
          <Tag>{t('maintenanceReport.draft.notStarted')}</Tag>
        ) : (
          <Tag color="gold">{t('maintenanceReport.status.DRAFT')}</Tag>
        ),
    },
    {
      title: t('maintenanceReport.column.actions'),
      key: 'actions',
      render: (_value, record) => (
        <Space size="small" wrap>
          <Button
            size="small"
            type={record.reportId === null ? 'primary' : 'default'}
            onClick={() => void navigate(`${WORK_ORDER_SUMMARIES_PATH}/${record.repairRequestId}`)}
          >
            {record.reportId === null
              ? t('maintenanceReport.summary.start')
              : t('maintenanceReport.summary.resume')}
          </Button>
          {resolveSourceWorkOrderPath === undefined ? null : (
            <Button
              size="small"
              onClick={() => void navigate(resolveSourceWorkOrderPath(record.repairRequestId))}
            >
              {t('maintenanceReport.summary.sourceWorkOrder')}
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Space orientation="vertical" size="large" style={{ width: '100%' }}>
      <PageHeader
        title={t('maintenanceReport.summary.title')}
        description={t('maintenanceReport.summary.subtitle')}
      />
      {error === null ? null : (
        <Alert
          action={
            <Button
              size="small"
              onClick={() => {
                setError(null);
                setLoading(true);
                setReloadToken((token) => token + 1);
              }}
            >
              {t('maintenanceReport.retry')}
            </Button>
          }
          showIcon
          title={error}
          type="error"
        />
      )}
      <Table<WorkOrderSummaryCandidate>
        columns={columns}
        dataSource={items}
        loading={loading}
        locale={{ emptyText: t('maintenanceReport.summary.empty') }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: total ?? items.length,
          showSizeChanger: false,
          onChange: (nextPage) => {
            setLoading(true);
            setPage(nextPage);
          },
        }}
        rowKey="repairRequestId"
      />
    </Space>
  );
}
