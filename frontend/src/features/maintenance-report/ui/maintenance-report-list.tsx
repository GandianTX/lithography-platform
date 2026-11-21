// src/features/maintenance-report/ui/maintenance-report-list.tsx
//
// 独立历史维修记录入口：只列本人历史案例报告（sourceType=HISTORICAL_CASE）。
// 列表本身不发写请求；「新建」进入空白分步表单。

import { useEffect, useState } from 'react';
import { Alert, Button, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router';

import { isGraphQLIngressError } from '@/shared/graphql';
import { useI18n } from '@/shared/i18n';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { PageHeader } from '@/shared/ui/page-header';

import type {
  MaintenanceReportExportFormat,
  MaintenanceReportSummary,
} from '../infrastructure/maintenance-report.types';
import {
  exportMaintenanceReport,
  fetchMyMaintenanceReports,
} from '../infrastructure/maintenance-report-adapter';

import { downloadMaintenanceReportExport } from './maintenance-report-download';
import { MAINTENANCE_RECORDS_PATH } from './maintenance-report-editor-page';
import { reportStatusLabelKey } from './report-status-label';

const PAGE_SIZE = 20;

export function MaintenanceReportList() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [items, setItems] = useState<MaintenanceReportSummary[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  /** 已保存版本导出（currentVersionNo>0）；拒绝原因来自服务端 userMessage */
  const handleExport = (
    record: MaintenanceReportSummary,
    format: MaintenanceReportExportFormat,
  ) => {
    if (record.currentVersionNo <= 0 || exporting !== null) return;
    setExportError(null);
    setExporting(`${record.id}:${format}`);
    void (async () => {
      try {
        const result = await exportMaintenanceReport({
          format,
          savedVersion: { reportId: record.id },
        });
        downloadMaintenanceReportExport(result);
      } catch (exportErrorValue) {
        setExportError(
          isGraphQLIngressError(exportErrorValue)
            ? exportErrorValue.userMessage
            : t('maintenanceReport.export.failed'),
        );
      } finally {
        setExporting(null);
      }
    })();
  };

  // 只读列表：加载放在异步任务里，effect 内不直接 setState（避免级联渲染）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await fetchMyMaintenanceReports({
          page,
          pageSize: PAGE_SIZE,
          sourceType: 'HISTORICAL_CASE',
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

  const columns: ColumnsType<MaintenanceReportSummary> = [
    {
      title: t('maintenanceReport.field.maintenanceDate'),
      dataIndex: 'maintenanceDate',
      key: 'maintenanceDate',
      render: (value: string | null) => value ?? '—',
    },
    {
      title: t('maintenanceReport.column.title'),
      dataIndex: 'title',
      key: 'title',
      render: (_value: string | null, record) =>
        record.title ?? t('maintenanceReport.source.HISTORICAL_CASE'),
    },
    {
      title: t('maintenanceReport.column.status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: MaintenanceReportSummary['status']) => (
        <Tag color={status === 'DRAFT' ? 'gold' : 'green'}>{t(reportStatusLabelKey(status))}</Tag>
      ),
    },
    {
      title: t('maintenanceReport.column.updatedAt'),
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      render: (value: string) => formatDateTimeText(value),
    },
    {
      title: t('maintenanceReport.column.actions'),
      key: 'actions',
      render: (_value, record) => (
        <Space size="small" wrap>
          <Button
            size="small"
            onClick={() => void navigate(`${MAINTENANCE_RECORDS_PATH}/${record.id}`)}
          >
            {record.status === 'DRAFT'
              ? t('maintenanceReport.summary.resume')
              : t('maintenanceReport.open')}
          </Button>
          {record.currentVersionNo > 0 ? (
            <>
              <Button
                size="small"
                disabled={exporting !== null}
                loading={exporting === `${record.id}:DOCX`}
                onClick={() => handleExport(record, 'DOCX')}
              >
                {t('maintenanceReport.export.word')}
              </Button>
              <Button
                size="small"
                disabled={exporting !== null}
                loading={exporting === `${record.id}:PDF`}
                onClick={() => handleExport(record, 'PDF')}
              >
                {t('maintenanceReport.export.pdf')}
              </Button>
            </>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <Space orientation="vertical" size="large" style={{ width: '100%' }}>
      <PageHeader
        title={t('maintenanceReport.historical.title')}
        description={t('maintenanceReport.historical.subtitle')}
        extra={
          <Button type="primary" onClick={() => void navigate(`${MAINTENANCE_RECORDS_PATH}/new`)}>
            {t('maintenanceReport.historical.new')}
          </Button>
        }
      />
      {exportError === null ? null : <Alert showIcon title={exportError} type="error" />}
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
      <Table<MaintenanceReportSummary>
        columns={columns}
        dataSource={items}
        loading={loading}
        locale={{ emptyText: t('maintenanceReport.historical.empty') }}
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
        rowKey="id"
      />
    </Space>
  );
}
