// src/features/admin-document-database/ui/admin-repair-requests-tab.tsx

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TableColumnsType } from 'antd';
import {
  Alert,
  Button,
  Descriptions,
  Divider,
  Drawer,
  Input,
  Pagination,
  Select,
  Skeleton,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import dayjs from 'dayjs';

import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { KbSearchField, KbToolbarButton } from '@/shared/ui/knowledge-base';
import {
  REPAIR_HANDLING_RESULT_LABELS,
  REPAIR_HANDLING_STATUS_LABELS,
  resolveRepairClosureState,
} from '@/shared/ui/repair-request-status-labels';
import { StatusPill } from '@/shared/ui/status-pill';

import { useAdminRepairRequestSummary } from '../application/use-admin-document-detail';
import { useAdminDocumentList } from '../application/use-admin-document-list';
import { useDebouncedValue } from '../application/use-debounced-value';
import type {
  AdminRepairRequestFilter,
  AdminRepairRequestListItem,
} from '../infrastructure/admin-document-database.types';
import {
  fetchAdminEquipmentModelOptions,
  fetchAdminRepairRequests,
} from '../infrastructure/admin-document-database-adapter';

import { AdminCreatedAtFilter } from './admin-created-at-filter';
import { type AdminCreatedAtRangeState, toAdminCreatedAtRange } from './admin-created-at-range';
import { toEffectiveAdminFilter } from './admin-effective-filter';
import { AdminListStates } from './admin-list-states';
import { AdminRepairRequestRevisionModal } from './admin-repair-request-revision-modal';

const RESOLUTION_STATUS_LABELS: Record<'PENDING' | 'RESOLVED', string> = {
  PENDING: '处理中',
  RESOLVED: '已解决',
};

type PersistedListViewState = {
  requestNoKeyword: string;
  customerKeyword: string;
  errorCode: string;
  isAccepted: boolean | undefined;
  equipmentModelId: number | undefined;
  createdAtFrom: string | null;
  createdAtTo: string | null;
  page: number;
};

function readPersistedListViewState(key: string | undefined): PersistedListViewState | null {
  if (!key) return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as PersistedListViewState) : null;
  } catch {
    return null;
  }
}

function toPersistedRange(from: string | null, to: string | null): AdminCreatedAtRangeState {
  if (!from && !to) return null;
  return [from ? dayjs(from) : null, to ? dayjs(to) : null];
}

/**
 * 列表工单真实进度：主状态由 closureStatus 与 closedAt 联合判定（未结单不得写成已结单），
 * 处理结果/状态为辅助事实；最后回复单独标注，避免把「已解决」误读成工单已结单。
 * 显式未结单显示「未结单」；字段缺失、非法值或状态与时间矛盾按不可确认展示。
 */
function AdminWorkOrderStatusCell({ record }: { record: AdminRepairRequestListItem }) {
  const closureState = resolveRepairClosureState(record.closureStatus, record.closedAt);
  const closed = closureState === 'CLOSED';
  const resultLabel = record.handlingResult
    ? REPAIR_HANDLING_RESULT_LABELS[record.handlingResult]
    : null;
  const statusLabel = record.handlingStatus
    ? REPAIR_HANDLING_STATUS_LABELS[record.handlingStatus]
    : null;
  const showResultText =
    resultLabel !== null && !(closed && record.handlingResult === 'INTERRUPTED');

  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs">
      <div className="flex flex-wrap items-center gap-1">
        {closed ? (
          <StatusPill tone="ok">
            {record.handlingResult === 'INTERRUPTED' ? '已结单 · 维修中断' : '已结单'}
          </StatusPill>
        ) : closureState === 'OPEN' ? (
          <StatusPill tone="warn">未结单</StatusPill>
        ) : (
          <StatusPill tone="neutral">结单状态未知</StatusPill>
        )}
        {showResultText ? <span className="text-text-secondary">{resultLabel}</span> : null}
      </div>
      <span className="text-text-secondary">
        {closed
          ? record.closedAt
            ? `结单于 ${formatDateTimeText(record.closedAt)}`
            : '已结单'
          : closureState === 'UNKNOWN'
            ? `结单状态未知 · 处理状态：${statusLabel ?? '未记录'}`
            : `处理状态：${statusLabel ?? '未记录'}`}
      </span>
      {record.latestResolutionStatus ? (
        <span className="text-text-tertiary">
          最后回复：{RESOLUTION_STATUS_LABELS[record.latestResolutionStatus]}
        </span>
      ) : null}
    </div>
  );
}

/** 维修申请标签：管理员全局只读列表 + 组合筛选 + 详情入口
 *
 * PR3 R7 S5：整体迁入单张知识库卡（卡内工具区 + 主搜索 + 筛选展开区 +
 * 紧凑表格 + 卡底分页）；精确条件全部保留，仅常态入口收进「筛选」。
 *
 * 详情有两种承载方式：
 * - 传入 onOpenDetail（工单管理页）：点击详情进入独立详情页；
 * - 未传入（文档数据库内嵌标签）：保持原有侧边抽屉。
 * viewStateKey 用于从详情返回时尽量恢复筛选与分页。 */
export function AdminRepairRequestsTab({
  onOpenDetail,
  viewStateKey,
}: {
  onOpenDetail?: (requestId: number) => void;
  viewStateKey?: string;
} = {}) {
  const [persisted] = useState(() => readPersistedListViewState(viewStateKey));
  const [requestNoKeyword, setRequestNoKeyword] = useState(persisted?.requestNoKeyword ?? '');
  const [customerKeyword, setCustomerKeyword] = useState(persisted?.customerKeyword ?? '');
  const [errorCode, setErrorCode] = useState(persisted?.errorCode ?? '');
  const [isAccepted, setIsAccepted] = useState<boolean | undefined>(persisted?.isAccepted);
  const [equipmentModelId, setEquipmentModelId] = useState<number | undefined>(
    persisted?.equipmentModelId,
  );
  const [createdAtRange, setCreatedAtRange] = useState<AdminCreatedAtRangeState>(() =>
    toPersistedRange(persisted?.createdAtFrom ?? null, persisted?.createdAtTo ?? null),
  );
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [summaryRequestId, setSummaryRequestId] = useState<number | null>(null);
  const [revisionOpen, setRevisionOpen] = useState(false);
  // 设备型号下拉：调用本 feature 自己的 adapter（fetchAdminEquipmentModelOptions），
  // 保持 feature 之间不直接跨依赖（frontend/docs/dependency-rules.md）。
  // 注：equipmentModels 查询目前在 reference-document / repair-request / 本 feature
  //   三处各自实现，后续宜提升为 entity/shared 公开读 API 统一去重（PR3 review 建议项）。
  const [modelOptions, setModelOptions] = useState<
    { id: number; modelCode: string; modelName: string }[]
  >([]);
  const [modelsFailed, setModelsFailed] = useState(false);

  useEffect(() => {
    let disposed = false;

    fetchAdminEquipmentModelOptions()
      .then((models) => {
        if (!disposed) {
          setModelOptions(models);
        }
      })
      .catch(() => {
        if (!disposed) {
          setModelsFailed(true);
        }
      });

    return () => {
      disposed = true;
    };
  }, []);

  const debouncedRequestNo = useDebouncedValue(requestNoKeyword.trim());
  const debouncedCustomer = useDebouncedValue(customerKeyword.trim());
  const debouncedErrorCode = useDebouncedValue(errorCode.trim());
  const timeFilter = toAdminCreatedAtRange(createdAtRange);

  // R4 有效筛选单一真源：请求参数、reloadKey、hasActiveFilter 从同一份对象派生
  const effectiveFilter = useMemo(
    () =>
      toEffectiveAdminFilter<AdminRepairRequestFilter>({
        requestNo: debouncedRequestNo,
        customerKeyword: debouncedCustomer,
        errorCode: debouncedErrorCode,
        isAccepted,
        equipmentModelId,
        ...timeFilter,
      }),
    [
      debouncedRequestNo,
      debouncedCustomer,
      debouncedErrorCode,
      isAccepted,
      equipmentModelId,
      timeFilter,
    ],
  );
  // 筛选变化触发回第 1 页；请求序号竞态防护在列表 hook 内
  const reloadKey = JSON.stringify(effectiveFilter);
  const hasActiveFilter = Object.keys(effectiveFilter).length > 0;

  const resetFilters = () => {
    setRequestNoKeyword('');
    setCustomerKeyword('');
    setErrorCode('');
    setIsAccepted(undefined);
    setEquipmentModelId(undefined);
    setCreatedAtRange(null);
  };

  const fetcher = useMemo(
    () => (page: number, pageSize: number) =>
      fetchAdminRepairRequests(page, pageSize, effectiveFilter),
    [effectiveFilter],
  );

  const { state, goToPage, reload } = useAdminDocumentList<AdminRepairRequestListItem>(
    fetcher,
    reloadKey,
    {
      failureMessage: '维修申请列表加载失败，请稍后重试。',
      initialPage: persisted?.page ?? 1,
    },
  );
  const summary = useAdminRepairRequestSummary(summaryRequestId);

  // 从独立详情页返回时恢复筛选与分页（仅工单管理页启用）
  useEffect(() => {
    if (!viewStateKey) return;
    const snapshot: PersistedListViewState = {
      requestNoKeyword,
      customerKeyword,
      errorCode,
      isAccepted,
      equipmentModelId,
      createdAtFrom: createdAtRange?.[0]?.toISOString() ?? null,
      createdAtTo: createdAtRange?.[1]?.toISOString() ?? null,
      page: state.status === 'ready' ? state.page : (persisted?.page ?? 1),
    };
    try {
      window.sessionStorage.setItem(viewStateKey, JSON.stringify(snapshot));
    } catch {
      // 会话存储不可用时忽略，不阻断列表
    }
  }, [
    viewStateKey,
    requestNoKeyword,
    customerKeyword,
    errorCode,
    isAccepted,
    equipmentModelId,
    createdAtRange,
    state,
    persisted,
  ]);

  const openDetail = useCallback(
    (requestId: number) => {
      if (onOpenDetail) {
        onOpenDetail(requestId);
        return;
      }
      setSummaryRequestId(requestId);
    },
    [onOpenDetail],
  );

  // 紧凑列宽 + ellipsis/Tooltip：scroll.x 约 1144，1366 视口即可完整可见；
  // 操作列 fixed right 作为窄视口下的可发现性保障（字段一个不删，PR3 R7 S5/视觉报告 3.5）
  const columns = useMemo<TableColumnsType<AdminRepairRequestListItem>>(
    () => [
      // 申请编号 / 客户为变长文本：与公司、设备型号同用 ellipsis + Tooltip，
      // 避免长昵称或真实 RR 编号在紧凑列宽下换行把行高撑到两行（PR3 R7 S5 表格密度）
      {
        dataIndex: 'requestNo',
        key: 'requestNo',
        ellipsis: true,
        render: (value: string) => (
          <Tooltip title={value}>
            <span>{value}</span>
          </Tooltip>
        ),
        title: '申请编号',
        width: 136,
      },
      {
        dataIndex: 'customerNickname',
        key: 'customerNickname',
        ellipsis: true,
        render: (value: string) => (
          <Tooltip title={value}>
            <span>{value}</span>
          </Tooltip>
        ),
        title: '客户',
        width: 92,
      },
      {
        dataIndex: 'companyName',
        key: 'companyName',
        ellipsis: true,
        render: (value: string | null) => (
          <Tooltip title={value ?? '—'}>
            <span>{value ?? '—'}</span>
          </Tooltip>
        ),
        title: '公司',
        width: 136,
      },
      {
        dataIndex: 'equipmentModelName',
        key: 'equipmentModelName',
        ellipsis: true,
        render: (value: string) => (
          <Tooltip title={value}>
            <span>{value}</span>
          </Tooltip>
        ),
        title: '设备型号',
        width: 168,
      },
      { dataIndex: 'errorCode', key: 'errorCode', title: '故障码', width: 92 },
      {
        dataIndex: 'isAccepted',
        key: 'isAccepted',
        render: (value: boolean) =>
          value ? (
            <StatusPill tone="ok">已接单</StatusPill>
          ) : (
            <StatusPill tone="warn">待接单</StatusPill>
          ),
        title: '接单状态',
        width: 92,
      },
      {
        dataIndex: 'closureStatus',
        key: 'workOrderStatus',
        render: (_value, record) => <AdminWorkOrderStatusCell record={record} />,
        title: '工单状态',
        width: 196,
      },
      {
        dataIndex: 'createdAt',
        key: 'createdAt',
        render: (value: string) => formatDateTimeText(value),
        title: '创建时间',
        width: 140,
      },
      {
        fixed: 'right',
        key: 'actions',
        render: (_value, record) => (
          <Button onClick={() => openDetail(record.id)} size="small" type="link">
            详情
          </Button>
        ),
        title: '操作',
        width: 92,
      },
    ],
    [openDetail],
  );

  return (
    <div className="kb-card">
      {/* 卡内工具区（PR3 R7 S5）：主搜索 + 筛选入口；其余精确条件全部保留，
          只是从常态平铺收进「筛选」展开区（视觉报告 3.4 工具区差异） */}
      <div className="kb-toolbar">
        <KbSearchField
          clearLabel="清除申请编号搜索"
          onChange={setRequestNoKeyword}
          placeholder="按申请编号搜索"
          value={requestNoKeyword}
        />
        <KbToolbarButton
          active={hasActiveFilter}
          aria-expanded={filterPanelOpen}
          onClick={() => setFilterPanelOpen((previous) => !previous)}
        >
          筛选
        </KbToolbarButton>
      </div>

      {filterPanelOpen ? (
        <div className="kb-filter-panel">
          <Input
            allowClear
            maxLength={100}
            placeholder="按客户昵称/公司搜索"
            style={{ width: 200 }}
            value={customerKeyword}
            onChange={(event) => setCustomerKeyword(event.target.value)}
          />
          <Input
            allowClear
            maxLength={100}
            placeholder="输入完整故障码"
            style={{ width: 150 }}
            value={errorCode}
            onChange={(event) => setErrorCode(event.target.value)}
          />
          <Select
            allowClear
            placeholder="接单状态"
            style={{ width: 130 }}
            value={isAccepted}
            onChange={(value) => setIsAccepted(value)}
            options={[
              { label: '已接单', value: true },
              { label: '待接单', value: false },
            ]}
          />
          <Select
            allowClear
            placeholder="设备型号"
            style={{ width: 220 }}
            value={equipmentModelId}
            onChange={(value) => setEquipmentModelId(value)}
            options={modelOptions.map((model) => ({
              label: `${model.modelName}（${model.modelCode}）`,
              value: model.id,
            }))}
          />
          <AdminCreatedAtFilter onChange={setCreatedAtRange} value={createdAtRange} />
          <KbToolbarButton onClick={resetFilters}>重置</KbToolbarButton>
        </div>
      ) : null}

      {modelsFailed ? (
        /* 型号告警与表格同卡（PR3 R7 S5 四态同卡要求） */
        <div className="kb-card-state">
          <Alert
            showIcon
            title="设备型号选项加载失败，型号筛选暂不可用，可继续使用其他筛选。"
            type="warning"
          />
        </div>
      ) : null}

      <AdminListStates
        emptyLabel="暂无维修申请。"
        filteredEmptyLabel="没有符合筛选条件的维修申请。"
        hasActiveFilter={hasActiveFilter}
        onRetry={reload}
        state={state}
        variant="knowledge-base"
      >
        {state.status === 'ready' && state.total > 0 ? (
          <>
            <div className="kb-table-scope">
              <Table<AdminRepairRequestListItem>
                columns={columns}
                dataSource={state.items}
                pagination={false}
                rowKey="id"
                scroll={{ x: 1040 }}
              />
            </div>
            <div className="kb-card-footer">
              <span>共 {state.total} 条</span>
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
        extra={
          summary.state.status === 'ready' ? (
            <Button onClick={() => setRevisionOpen(true)} size="small" type="primary">
              修订
            </Button>
          ) : null
        }
        onClose={() => {
          setRevisionOpen(false);
          setSummaryRequestId(null);
        }}
        open={summaryRequestId !== null}
        title={`工单详情${summary.state.status === 'ready' ? ` · ${summary.state.detail.requestNo}` : ''}`}
        size="large"
      >
        {summary.state.status === 'loading' ? <Skeleton active /> : null}
        {summary.state.status === 'failed' ? (
          <Alert
            action={
              <Button onClick={summary.retry} size="small">
                重试
              </Button>
            }
            title={summary.state.message}
            showIcon
            type="error"
          />
        ) : null}
        {summary.state.status === 'ready' ? (
          <div className="flex flex-col gap-4">
            <Descriptions
              column={1}
              items={[
                { key: 'customer', label: '客户', children: summary.state.detail.customerNickname },
                {
                  key: 'company',
                  label: '公司',
                  children: summary.state.detail.companyName ?? '—',
                },
                {
                  key: 'model',
                  label: '设备型号',
                  children: `${summary.state.detail.equipmentModelName}（${summary.state.detail.equipmentModelCode}）`,
                },
                { key: 'errorCode', label: '故障码', children: summary.state.detail.errorCode },
                {
                  key: 'fault',
                  label: '故障描述',
                  children: summary.state.detail.faultDescription || '—',
                },
                {
                  key: 'accepted',
                  label: '接单',
                  children: summary.state.detail.isAccepted
                    ? `${summary.state.detail.acceptedByEngineerNickname ?? '—'} · ${summary.state.detail.acceptedAt ? formatDateTimeText(summary.state.detail.acceptedAt) : '—'}`
                    : '待接单',
                },
                {
                  key: 'createdAt',
                  label: '创建时间',
                  children: formatDateTimeText(summary.state.detail.createdAt),
                },
                {
                  key: 'revision',
                  label: '当前修订版本',
                  children: `v${summary.state.detail.currentRevisionNo}`,
                },
              ]}
              size="small"
            />

            <div>
              <p className="mb-2 font-medium">申请正文</p>
              <pre className="max-h-[420px] overflow-auto rounded border border-[var(--panel-border)] bg-[var(--filter-bar-bg)] p-3 text-xs whitespace-pre-wrap">
                {summary.state.detail.contentMd}
              </pre>
            </div>

            <Divider style={{ marginBlock: 0 }} />

            <div>
              <p className="mb-2 font-medium">结单与处理结果</p>
              <Descriptions
                column={1}
                items={[
                  {
                    key: 'handlingResult',
                    label: '处理结果',
                    children: summary.state.detail.handlingResult
                      ? REPAIR_HANDLING_RESULT_LABELS[summary.state.detail.handlingResult]
                      : '未记录',
                  },
                  {
                    key: 'handlingStatus',
                    label: '处理状态',
                    children: summary.state.detail.handlingStatus
                      ? REPAIR_HANDLING_STATUS_LABELS[summary.state.detail.handlingStatus]
                      : '未记录',
                  },
                  {
                    key: 'latestResolutionStatus',
                    label: '最后回复状态',
                    children: summary.state.detail.latestResolutionStatus
                      ? RESOLUTION_STATUS_LABELS[summary.state.detail.latestResolutionStatus]
                      : '未记录',
                  },
                  {
                    key: 'closureStatus',
                    label: '结单状态',
                    children: (() => {
                      const closureState = resolveRepairClosureState(
                        summary.state.detail.closureStatus,
                        summary.state.detail.closedAt,
                      );
                      return closureState === 'CLOSED'
                        ? '已结单'
                        : closureState === 'OPEN'
                          ? '未结单'
                          : '结单状态未知（数据缺失）';
                    })(),
                  },
                  {
                    key: 'closedAt',
                    label: '结单时间',
                    children: summary.state.detail.closedAt
                      ? formatDateTimeText(summary.state.detail.closedAt)
                      : '—',
                  },
                  {
                    key: 'closureReason',
                    label: '结单原因',
                    children: summary.state.detail.closureReason || '—',
                  },
                ]}
                size="small"
              />
            </div>

            <Divider style={{ marginBlock: 0 }} />

            <div>
              <p className="mb-2 font-medium">内部维修过程</p>
              {summary.state.detail.processEntries.length === 0 ? (
                <p className="text-text-tertiary text-sm">暂无已提交过程。</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {summary.state.detail.processEntries.map((entry) => (
                    <div className="rounded border border-[var(--panel-border)] p-3" key={entry.id}>
                      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-secondary)]">
                        <Tag>v{entry.versionNo}</Tag>
                        <span>{formatDateTimeText(entry.createdAt)}</span>
                        <span>时间来源 {entry.timeSource === 'SERVER' ? '服务端' : '人工'}</span>
                        {entry.file ? (
                          <span>
                            原件：{entry.file.originalFilename}（{entry.file.byteSize} 字节）
                          </span>
                        ) : null}
                      </div>
                      <p className="whitespace-pre-wrap text-sm">{entry.operationText}</p>
                      {entry.testResult ? (
                        <p className="text-text-secondary mt-1 text-xs">
                          测试结果：{entry.testResult}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Divider style={{ marginBlock: 0 }} />

            <div>
              <p className="mb-2 font-medium">客户回复</p>
              {summary.state.detail.responses.length === 0 ? (
                <p className="text-text-tertiary text-sm">暂无客户可见回复。</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {summary.state.detail.responses.map((response) => (
                    <div
                      className="rounded border border-[var(--panel-border)] p-3"
                      key={response.id}
                    >
                      <div className="text-text-secondary mb-1 flex flex-wrap items-center gap-x-3 text-xs">
                        <span>{response.engineerNickname}</span>
                        <span>{formatDateTimeText(response.createdAt)}</span>
                        <Tag color={response.resolutionStatus === 'RESOLVED' ? 'green' : 'blue'}>
                          {RESOLUTION_STATUS_LABELS[response.resolutionStatus]}
                        </Tag>
                      </div>
                      <p className="whitespace-pre-wrap text-sm">{response.responseText}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Divider style={{ marginBlock: 0 }} />

            <div>
              <p className="mb-2 font-medium">修订历史</p>
              {summary.state.detail.revisions.length === 0 ? (
                <p className="text-text-tertiary text-sm">暂无修订记录。</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {summary.state.detail.revisions.map((revision) => (
                    <div
                      className="rounded border border-[var(--panel-border)] p-3 text-sm"
                      key={revision.revisionNo}
                    >
                      <div className="text-text-secondary mb-1 flex flex-wrap items-center gap-x-3 text-xs">
                        <Tag>
                          v{revision.previousVersion} → v{revision.revisionNo}
                        </Tag>
                        <span>{revision.actorNickname}</span>
                        <span>{formatDateTimeText(revision.createdAt)}</span>
                      </div>
                      <p className="whitespace-pre-wrap">{revision.reason}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </Drawer>

      {summary.state.status === 'ready' ? (
        <AdminRepairRequestRevisionModal
          detail={summary.state.detail}
          key={`${summary.state.detail.id}:${summary.state.detail.currentRevisionNo}:${revisionOpen}`}
          onClose={() => setRevisionOpen(false)}
          onSaved={summary.retry}
          open={revisionOpen}
        />
      ) : null}
    </div>
  );
}
