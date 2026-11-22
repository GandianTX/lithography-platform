// src/features/my-records/ui/my-records-list.tsx

import { useMemo, useState } from 'react';
import type { TableColumnsType } from 'antd';
import { Tag } from 'antd';
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Pagination,
  Segmented,
  Select,
  Skeleton,
  Table,
} from 'antd';
import { useNavigate } from 'react-router';

import { useI18n } from '@/shared/i18n';
import { formatDateTimeText } from '@/shared/ui/format-date-time';

import { resolveTask06DraftEditorEntry } from '../application/task-06-editor-entry';
import { useMyRecordsList } from '../application/use-my-records-list';
import { useMyRecordsStats } from '../application/use-my-records-stats';
import type {
  MyRecordListFilter,
  MyRecordRecordKind,
  MyRecordSourceType,
  MyRecordStatus,
  MyRecordSummary,
} from '../infrastructure/my-records.types';
import { isDraftRecordStatus } from '../infrastructure/my-records.types';

import { MY_RECORD_SOURCE_LABEL_KEYS, resolveStatusLabelKey } from './my-record-labels';
import { buildMyRecordDetailPath, buildPublishedDocumentPath } from './my-record-paths';
import { MyRecordSyncStatusBadge } from './my-record-sync-status';

const STATUS_TAG_COLORS: Record<string, string> = {
  DRAFT: 'default',
  RETURNED: 'warning',
  PENDING_REVIEW: 'processing',
  APPROVED: 'success',
  SUBMITTED: 'processing',
};

/**
 * 我的资料记录列表（任务 07，布局对齐 Demo V44 的 V24MyRecords）。
 *
 * - 顶部统计区（Demo 对齐）：草稿/已入库为服务端同一归属谓词的全量 total；
 *   待同步/版本冲突在任务 09 未接入前无真实统计接口，显示「—」并标注未接入，
 *   不使用 Demo 演示假数据，也不用当前页数量冒充总数；
 * - 标题搜索：Input.Search 提交后下推 titleKeyword，由后端在本人归属谓词内
 *   全量 LIKE 匹配（不做客户端当页过滤——后端不支持全量搜索时不得声称搜索全部）；
 * - 只渲染后端真实字段：标题/来源、填写状态、版本、同步状态、更新时间、已发布成品；
 * - 同步状态列展示后端适配层真实展示值（任务 09 未装配恒 NOT_CONNECTED），
 *   不从保存/提交成功推断「已同步」；「处理冲突」按钮仅在真实冲突 + 有权处理 +
 *   已接入路由三者齐备时出现（本轮无路由，不渲染占位入口）；
 * - 未完成记录提供「继续填写／继续核对」：按来源类型经任务 06 对接点指向真实路由
 *   （独立历史记录→报告编辑器，工单总结→只读核对页）；activeRole 非 ENGINEER 时
 *   入口不可用（管理员不能借任务 07 续填，后端写入口仅工程师）；草稿同时提供
 *   「查看记录」只读入口；
 * - 正式记录提供只读详情；已发布正式资料另给「查看正式资料」入口；
 * - 「记录历史故障经验」新建入口在页面页头（工程师专属），不在本组件内渲染；
 * - 本页读取后端「本人创建 + 本组织资源授权」谓词结果（2026-11-21 页面口径：
 *   工程师与管理员同用本页，管理员无本人记录时展示暂无记录；他人记录不出现在本页，
 *   管理员查看他人正式资料走参考资料库/文档数据库），不读取管理身份；
 *   删除等作者专属操作仍只对本人名下记录可用。
 */
export function MyRecordsList({ activeRole }: { activeRole?: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [recordKind, setRecordKind] = useState<MyRecordRecordKind>('ALL');
  const [sourceType, setSourceType] = useState<MyRecordSourceType | undefined>(undefined);
  const [keywordInput, setKeywordInput] = useState('');
  const [titleKeyword, setTitleKeyword] = useState('');

  const filter = useMemo<MyRecordListFilter | undefined>(() => {
    const next: MyRecordListFilter = {};
    if (recordKind !== 'ALL') next.recordKind = recordKind;
    if (sourceType !== undefined) next.sourceType = sourceType;
    const keyword = titleKeyword.trim();
    if (keyword.length > 0) next.titleKeyword = keyword;
    return Object.keys(next).length > 0 ? next : undefined;
  }, [recordKind, sourceType, titleKeyword]);

  const { state, goToPage, reload } = useMyRecordsList(filter);
  const stats = useMyRecordsStats();

  const statusLabel = (status: MyRecordStatus): string => t(resolveStatusLabelKey(status));

  const sourceLabel = (source: MyRecordSourceType): string =>
    t(MY_RECORD_SOURCE_LABEL_KEYS[source]);

  const statCards: Array<{
    hint: boolean;
    key: string;
    title: string;
    value: number | null;
  }> = [
    { hint: false, key: 'draft', title: t('myRecords.stats.draft'), value: stats.draftTotal },
    { hint: false, key: 'formal', title: t('myRecords.stats.formal'), value: stats.formalTotal },
    // 任务 09 未接入：无真实统计接口，恒显示「—」+ 未接入提示（不使用 Demo 假数据）
    { hint: true, key: 'pendingSync', title: t('myRecords.stats.pendingSync'), value: null },
    { hint: true, key: 'conflict', title: t('myRecords.stats.conflict'), value: null },
  ];

  const columns: TableColumnsType<MyRecordSummary> = [
    {
      key: 'title',
      ellipsis: true,
      title: t('myRecords.column.title'),
      width: 320,
      render: (_value, record) => (
        <div className="flex flex-col gap-1">
          <span title={record.title ?? ''}>{record.title ?? t('myRecords.titleFallback')}</span>
          <span className="text-text-secondary text-xs">
            {sourceLabel(record.sourceType)}
            {record.repairRequestId !== null
              ? ` · ${t('myRecords.workOrderRef', { id: record.repairRequestId })}`
              : ''}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      title: t('myRecords.column.status'),
      width: 120,
      render: (_value, record) => (
        <Tag color={STATUS_TAG_COLORS[record.status] ?? 'default'}>
          {statusLabel(record.status)}
        </Tag>
      ),
    },
    {
      key: 'version',
      title: t('myRecords.column.version'),
      width: 130,
      render: (_value, record) =>
        record.currentVersionNo > 0
          ? t('myRecords.versionValue', { no: record.currentVersionNo })
          : t('myRecords.versionNone'),
    },
    {
      key: 'syncStatus',
      title: t('myRecords.sync.column'),
      width: 180,
      render: (_value, record) => <MyRecordSyncStatusBadge view={record.syncStatus} />,
    },
    {
      key: 'updatedAt',
      title: t('myRecords.column.updatedAt'),
      width: 180,
      render: (_value, record) => formatDateTimeText(record.updatedAt),
    },
    {
      key: 'actions',
      title: t('myRecords.column.actions'),
      width: 220,
      render: (_value, record) => {
        const draft = isDraftRecordStatus(record.status);
        const editor = resolveTask06DraftEditorEntry({
          reportId: record.id,
          sourceType: record.sourceType,
          repairRequestId: record.repairRequestId,
          activeRole,
        });
        const resumeLabel =
          record.sourceType === 'WORK_ORDER_SUMMARY'
            ? t('myRecords.action.resumeSummary')
            : t('myRecords.action.resume');
        return (
          <div className="flex flex-wrap gap-2" onClick={(event) => event.stopPropagation()}>
            {draft ? (
              <Button
                disabled={!editor.available}
                onClick={() => {
                  if (editor.available && editor.path !== null) {
                    void navigate(editor.path);
                  }
                }}
                size="small"
                title={
                  editor.reasonKey === 'workOrderMissing'
                    ? t('myRecords.workOrderMissing')
                    : undefined
                }
                type="primary"
              >
                {resumeLabel}
              </Button>
            ) : null}
            <Button
              onClick={() => void navigate(buildMyRecordDetailPath(record.id))}
              size="small"
              type="link"
            >
              {t('myRecords.action.view')}
            </Button>
            {record.publishedDocumentId !== null ? (
              <Button
                onClick={() =>
                  void navigate(buildPublishedDocumentPath(record.publishedDocumentId as number))
                }
                size="small"
                type="link"
              >
                {t('myRecords.action.viewPublished')}
              </Button>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <div className="page-stack">
      <div className="flex flex-wrap gap-4">
        {statCards.map((card) => (
          <div key={card.key} className="min-w-36 flex-1">
            <Card size="small" title={card.title}>
              <div className="flex items-baseline gap-2">
                <span className="text-lg">{card.value === null ? '—' : card.value}</span>
                {card.hint ? (
                  <span className="text-text-secondary text-xs">
                    {t('myRecords.stats.notConnectedHint')}
                  </span>
                ) : null}
              </div>
            </Card>
          </div>
        ))}
      </div>

      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Input.Search
            allowClear
            onChange={(event) => {
              const value = event.target.value;
              setKeywordInput(value);
              // 清空即恢复全量（allowClear 点击 / 手动删空都立即重查，不残留旧关键词）
              if (value === '') setTitleKeyword('');
            }}
            onSearch={(value) => setTitleKeyword(value.trim())}
            placeholder={t('myRecords.searchPlaceholder')}
            value={keywordInput}
          />
          <Segmented<MyRecordRecordKind>
            onChange={(value) => setRecordKind(value)}
            options={[
              { label: t('myRecords.filter.all'), value: 'ALL' },
              { label: t('myRecords.filter.draft'), value: 'DRAFT' },
              { label: t('myRecords.filter.formal'), value: 'FORMAL' },
            ]}
            value={recordKind}
          />
          <Select<MyRecordSourceType>
            allowClear
            onChange={(value) => setSourceType(value ?? undefined)}
            options={[
              { label: t('myRecords.filter.sourceIndependent'), value: 'HISTORICAL_CASE' },
              { label: t('myRecords.filter.sourceWorkOrder'), value: 'WORK_ORDER_SUMMARY' },
            ]}
            placeholder={t('myRecords.filter.sourcePlaceholder')}
            value={sourceType}
            style={{ width: 220 }}
          />
        </div>

        {state.status === 'loading' ? <Skeleton active paragraph={{ rows: 6 }} /> : null}

        {state.status === 'failed' ? (
          <Alert
            action={
              <Button onClick={reload} size="small">
                {t('common.retry')}
              </Button>
            }
            showIcon
            title={state.message}
            type="error"
          />
        ) : null}

        {state.status === 'ready' && state.total === 0 ? (
          <Empty
            description={filter === undefined ? t('myRecords.empty') : t('myRecords.emptyFiltered')}
          />
        ) : null}

        {state.status === 'ready' && state.total > 0 ? (
          <>
            <Table<MyRecordSummary>
              columns={columns}
              dataSource={state.items}
              onRow={(record) => ({
                onClick: () => {
                  if (!isDraftRecordStatus(record.status)) {
                    void navigate(buildMyRecordDetailPath(record.id));
                  }
                },
                style: { cursor: isDraftRecordStatus(record.status) ? 'default' : 'pointer' },
              })}
              pagination={false}
              rowKey="id"
              scroll={{ x: 1040 }}
            />
            <div className="mt-4 flex items-center justify-between">
              <span className="text-text-secondary text-sm">
                {t('myRecords.total', { total: state.total })}
              </span>
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
      </Card>
    </div>
  );
}
