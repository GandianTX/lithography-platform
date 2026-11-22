// src/features/admin-document-database/ui/admin-ai-reports-tab.tsx

import { useMemo, useState } from 'react';
import type { TableColumnsType } from 'antd';
import { Alert, Button, Drawer, Input, Pagination, Skeleton, Table, Tooltip } from 'antd';

import { useI18n } from '@/shared/i18n';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { KbSearchField, KbToolbarButton } from '@/shared/ui/knowledge-base';

import { useAdminAiReportDetail } from '../application/use-admin-document-detail';
import { useAdminDocumentList } from '../application/use-admin-document-list';
import { useDebouncedValue } from '../application/use-debounced-value';
import type {
  AdminAiReportFilter,
  AdminAiReportListItem,
} from '../infrastructure/admin-document-database.types';
import { fetchAdminAiReports } from '../infrastructure/admin-document-database-adapter';

import { AdminCreatedAtFilter } from './admin-created-at-filter';
import { type AdminCreatedAtRangeState, toAdminCreatedAtRange } from './admin-created-at-range';
import { toEffectiveAdminFilter } from './admin-effective-filter';
import { AdminListStates } from './admin-list-states';

/**
 * AI 报告标签：只读列表 + 只读正文详情；不提供生成、训练、修改、删除控件
 * （计划表 S3 明确不做）。requestNo 以会话归属申请为权威（M-04 裁定），
 * requestMismatch=true 时显示审计警示。
 *
 * PR3 R7 S5：迁入单张知识库卡（卡内工具区 + 主搜索 + 筛选展开区 + 紧凑表格 +
 * 卡底分页）；报告类型等精确条件收进「筛选」展开区，能力不减。
 *
 * 任务 07 i18n 化：文案全部走共享 messages；列表/详情仍复用 PR3 既有历史读侧
 * （R037/R038 适用读侧），任务 05 合入后 AI 会话标签由其真实读侧承载，
 * 本报告标签数据面不变。
 */
export function AdminAiReportsTab() {
  const { t } = useI18n();
  const [requestNoKeyword, setRequestNoKeyword] = useState('');
  const [engineerKeyword, setEngineerKeyword] = useState('');
  const [reportType, setReportType] = useState('');
  const [createdAtRange, setCreatedAtRange] = useState<AdminCreatedAtRangeState>(null);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [detailReportId, setDetailReportId] = useState<number | null>(null);

  const debouncedRequestNo = useDebouncedValue(requestNoKeyword.trim());
  const debouncedEngineer = useDebouncedValue(engineerKeyword.trim());
  const debouncedReportType = useDebouncedValue(reportType.trim());
  const timeFilter = toAdminCreatedAtRange(createdAtRange);

  // R4 有效筛选单一真源：请求参数、reloadKey、hasActiveFilter 从同一份对象派生
  const effectiveFilter = useMemo(
    () =>
      toEffectiveAdminFilter<AdminAiReportFilter>({
        requestNo: debouncedRequestNo,
        engineerKeyword: debouncedEngineer,
        reportType: debouncedReportType,
        ...timeFilter,
      }),
    [debouncedRequestNo, debouncedEngineer, debouncedReportType, timeFilter],
  );
  // 筛选变化触发回第 1 页；请求序号竞态防护在列表 hook 内
  const reloadKey = JSON.stringify(effectiveFilter);
  const hasActiveFilter = Object.keys(effectiveFilter).length > 0;

  const resetFilters = () => {
    setRequestNoKeyword('');
    setEngineerKeyword('');
    setReportType('');
    setCreatedAtRange(null);
  };

  const fetcher = useMemo(
    () => (page: number, pageSize: number) => fetchAdminAiReports(page, pageSize, effectiveFilter),
    [effectiveFilter],
  );

  const { state, goToPage, reload } = useAdminDocumentList<AdminAiReportListItem>(
    fetcher,
    reloadKey,
    {
      failureMessage: t('adminDocDb.aiReports.failure'),
    },
  );
  const detail = useAdminAiReportDetail(detailReportId);

  // 紧凑列宽：scroll.x 由 1000 收紧到 786，两个验收视口下无需表格内部横滚（视觉报告 3.5）
  const columns = useMemo<TableColumnsType<AdminAiReportListItem>>(
    () => [
      {
        dataIndex: 'reportTitle',
        key: 'reportTitle',
        ellipsis: true,
        render: (value: string) => (
          <Tooltip title={value}>
            <span>{value}</span>
          </Tooltip>
        ),
        title: t('adminDocDb.aiReports.col.title'),
        width: 220,
      },
      {
        dataIndex: 'reportType',
        key: 'reportType',
        title: t('adminDocDb.aiReports.col.type'),
        width: 108,
      },
      {
        dataIndex: 'requestNo',
        key: 'requestNo',
        render: (value: string, record) =>
          record.requestMismatch ? (
            <Tooltip title={t('adminDocDb.aiReports.requestMismatch')}>
              <span className="text-[var(--ant-color-warning)]">{value} ⚠</span>
            </Tooltip>
          ) : (
            value
          ),
        title: t('adminDocDb.column.requestNo'),
        width: 150,
      },
      {
        dataIndex: 'engineerNickname',
        key: 'engineerNickname',
        title: t('adminDocDb.column.engineer'),
        width: 92,
      },
      {
        dataIndex: 'createdAt',
        key: 'createdAt',
        render: (value: string) => formatDateTimeText(value),
        title: t('adminDocDb.column.createdAt'),
        width: 140,
      },
      {
        key: 'actions',
        render: (_value, record) => (
          <Button onClick={() => setDetailReportId(record.id)} size="small" type="link">
            {t('adminDocDb.aiReports.action.content')}
          </Button>
        ),
        title: t('adminDocDb.column.actions'),
        width: 76,
      },
    ],
    [t],
  );

  return (
    <div className="kb-card">
      {/* 卡内工具区（PR3 R7 S5）：主搜索 + 筛选入口；工程师/报告类型/时间收进展开区 */}
      <div className="kb-toolbar">
        <KbSearchField
          clearLabel={t('adminDocDb.aiConversations.searchClear')}
          onChange={setRequestNoKeyword}
          placeholder={t('adminDocDb.aiConversations.searchPlaceholder')}
          value={requestNoKeyword}
        />
        <KbToolbarButton
          active={hasActiveFilter}
          aria-expanded={filterPanelOpen}
          onClick={() => setFilterPanelOpen((previous) => !previous)}
        >
          {t('adminDocDb.filter.toggle')}
        </KbToolbarButton>
      </div>

      {filterPanelOpen ? (
        <div className="kb-filter-panel">
          <Input
            allowClear
            maxLength={100}
            placeholder={t('adminDocDb.aiReports.engineerPlaceholder')}
            style={{ width: 200 }}
            value={engineerKeyword}
            onChange={(event) => setEngineerKeyword(event.target.value)}
          />
          <Input
            allowClear
            maxLength={100}
            placeholder={t('adminDocDb.aiReports.typePlaceholder')}
            style={{ width: 160 }}
            value={reportType}
            onChange={(event) => setReportType(event.target.value)}
          />
          <AdminCreatedAtFilter onChange={setCreatedAtRange} value={createdAtRange} />
          <KbToolbarButton onClick={resetFilters}>{t('adminDocDb.filter.reset')}</KbToolbarButton>
        </div>
      ) : null}

      <AdminListStates
        emptyLabel={t('adminDocDb.aiReports.empty')}
        filteredEmptyLabel={t('adminDocDb.aiReports.filteredEmpty')}
        hasActiveFilter={hasActiveFilter}
        onRetry={reload}
        state={state}
        variant="knowledge-base"
      >
        {state.status === 'ready' && state.total > 0 ? (
          <>
            <div className="kb-table-scope">
              <Table<AdminAiReportListItem>
                columns={columns}
                dataSource={state.items}
                pagination={false}
                rowKey="id"
                scroll={{ x: 786 }}
              />
            </div>
            <div className="kb-card-footer">
              <span>{t('adminDocDb.list.total', { total: state.total })}</span>
              <Pagination
                current={state.page}
                onChange={goToPage}
                pageSize={state.pageSize}
                showSizeChanger={false}
                size="small"
                total={state.total}
              />
            </div>
          </>
        ) : null}
      </AdminListStates>

      <Drawer
        destroyOnHidden
        onClose={() => setDetailReportId(null)}
        open={detailReportId !== null}
        title={
          detail.state.status === 'ready'
            ? detail.state.detail.reportTitle
            : t('adminDocDb.aiReports.drawer.fallbackTitle')
        }
        size="large"
      >
        {detail.state.status === 'loading' ? <Skeleton active /> : null}
        {detail.state.status === 'failed' ? (
          <Alert
            action={
              <Button onClick={detail.retry} size="small">
                {t('common.retry')}
              </Button>
            }
            title={detail.state.message}
            showIcon
            type="error"
          />
        ) : null}
        {detail.state.status === 'ready' ? (
          <div className="flex flex-col gap-4">
            <p className="m-0 text-sm text-[var(--text-muted)]">
              {t('adminDocDb.aiReports.detail.meta', {
                reportType: detail.state.detail.reportType,
                requestNo: detail.state.detail.requestNo,
                mismatch: detail.state.detail.requestMismatch
                  ? t('adminDocDb.aiReports.detail.mismatchSuffix')
                  : '',
                engineerNickname: detail.state.detail.engineerNickname,
                createdAt: formatDateTimeText(detail.state.detail.createdAt),
              })}
            </p>
            <pre className="max-h-[560px] overflow-auto rounded border border-[var(--panel-border)] bg-[var(--filter-bar-bg)] p-3 text-xs whitespace-pre-wrap">
              {detail.state.detail.contentMd}
            </pre>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
