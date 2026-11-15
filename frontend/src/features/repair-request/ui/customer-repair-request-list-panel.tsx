// src/features/repair-request/ui/customer-repair-request-list-panel.tsx

import { Button, Pagination, Popconfirm } from 'antd';

import { useI18n } from '@/shared/i18n';
import { DataCard } from '@/shared/ui/data-card';
import { EmptyState } from '@/shared/ui/empty-state';
import { ErrorState } from '@/shared/ui/error-state';
import { formatDateTimeMinuteText } from '@/shared/ui/format-date-time';
import { LoadingState } from '@/shared/ui/loading-state';
import { StatusPill } from '@/shared/ui/status-pill';

import type { CustomerRepairRequestListView } from '../application/use-customer-repair-request-list';
import type { RepairRequestListItem } from '../infrastructure/repair-request-read.types';

/**
 * 客户工作台左栏「我的维修申请」活动列表面板（PR5 整合工作台）。
 *
 * - 只接收稳定列表状态、分页与选择/删除回调，不直接调用 GraphQL、不感知竞态；
 * - 条目为「主内容列 + 固定宽状态/操作右栏」两列结构（`.customer-workspace-item`，
 *   仅客户工作台消费）：信息层级沿用 gkj activity-request（编号/型号·错误码/提交时间
 *   11px·11px·9px，三态交互色见 index.css `.activity-item`），选中态由 aria-current 表达；
 * - 主选择用语义化 button（键盘可达）且独占内容列；右栏顶部恒为状态胶囊，仅未接单在
 *   下方渲染删除确认（Popconfirm）。已接单不产生删除 DOM、无可聚焦元素，两态几何一致；
 * - 分页保留 AntD 语义（total>0 时恒显示分页，越界空页给可恢复提示，不隐藏分页）；
 * - 空库等状态与失败态互斥，加载失败不会被误读为「没有申请」。
 */

export type CustomerRepairRequestListPanelProps = {
  state: CustomerRepairRequestListView;
  deletingId: number | null;
  /** 仅在详情目标真实存在于当前已加载分页时非空（不误选、不伪造） */
  selectedRequestId: number | null;
  onCreateRequest: () => void;
  onDelete: (id: number) => void;
  onGoToPage: (page: number, pageSize: number) => void;
  /** 卡头「我的维修申请」入口：进入历史列表路由 */
  onOpenMyRequests: () => void;
  onRetry: () => void;
  onSelect: (id: number) => void;
};

function RequestItemRow({
  deleteDisabled,
  deleting,
  item,
  onDelete,
  onSelect,
  selected,
}: {
  deleteDisabled: boolean;
  deleting: boolean;
  item: RepairRequestListItem;
  onDelete: (id: number) => void;
  onSelect: (id: number) => void;
  selected: boolean;
}) {
  const { t } = useI18n();

  return (
    <div
      aria-current={selected ? 'true' : undefined}
      className="activity-item customer-workspace-item"
    >
      <button
        className="customer-workspace-item-main flex min-w-0 flex-col gap-1 px-3 py-[11px] text-left"
        onClick={() => onSelect(item.id)}
        type="button"
      >
        <span className="activity-item-code font-mono text-[11px] font-bold break-all">
          {item.requestNo}
        </span>
        <span className="text-[11px] font-bold break-words text-text">{`${item.equipmentModel.modelName}（${item.equipmentModel.modelCode}）· ${item.errorCode}`}</span>
        <span className="flex items-center justify-between gap-2 text-[9px] text-text-tertiary">
          <span>{t('customer.submittedAt')}</span>
          <span>{formatDateTimeMinuteText(item.createdAt)}</span>
        </span>
      </button>

      {/* 状态/操作栏（固定宽 rail）：顶部恒为状态胶囊；仅未接单渲染删除确认。
          已接单不产生删除 DOM（无禁用占位、无假按钮、无可聚焦元素）；
          两态几何一致由 index.css `.customer-workspace-item` 的同一套两列网格保证 */}
      <div className="customer-workspace-item-rail">
        <span className="customer-workspace-item-status">
          <StatusPill tone={item.isAccepted ? 'ok' : 'warn'}>
            {item.isAccepted ? t('customer.statusAccepted') : t('customer.statusPending')}
          </StatusPill>
        </span>
        {item.isAccepted ? null : (
          <div className="customer-workspace-item-actions">
            <Popconfirm
              cancelText={t('common.cancel')}
              okButtonProps={{ loading: deleting }}
              okText={t('common.confirmDelete')}
              onConfirm={() => onDelete(item.id)}
              title={t('common.deleteRequestTitle')}
            >
              <Button
                aria-label={t('customer.deleteRequestLabel', { requestNo: item.requestNo })}
                danger
                disabled={deleteDisabled}
                size="small"
                type="text"
              >
                {t('common.delete')}
              </Button>
            </Popconfirm>
          </div>
        )}
      </div>
    </div>
  );
}

export function CustomerRepairRequestListPanel({
  deletingId,
  onCreateRequest,
  onDelete,
  onGoToPage,
  onOpenMyRequests,
  onRetry,
  onSelect,
  selectedRequestId,
  state,
}: CustomerRepairRequestListPanelProps) {
  const { t } = useI18n();
  const ready = state.status === 'ready';
  const items = ready ? state.data.items : [];
  const total = ready ? state.data.total : 0;

  return (
    <DataCard
      extra={
        ready ? (
          <StatusPill tone="neutral">{t('customer.totalItems', { count: total })}</StatusPill>
        ) : null
      }
      title={
        <button
          className="customer-workspace-list-heading"
          onClick={onOpenMyRequests}
          type="button"
        >
          {t('customer.myRequests')}
        </button>
      }
    >
      <div className="flex flex-col gap-2">
        {state.status === 'loading' ? <LoadingState label={t('customer.loadingRequests')} /> : null}

        {state.status === 'failed' ? (
          <ErrorState
            action={
              <Button onClick={onRetry} size="small">
                {t('common.retry')}
              </Button>
            }
            title={state.message}
          />
        ) : null}

        {ready && total === 0 ? (
          <EmptyState
            action={
              <Button onClick={onCreateRequest} type="primary">
                {t('customer.createButton')}
              </Button>
            }
            description={t('customer.emptyDescription')}
            title={t('customer.emptyTitle')}
          />
        ) : null}

        {/* 越界空页（total>0 但当前页为空）不隐藏分页，给出可恢复提示 */}
        {ready && total > 0 && items.length === 0 ? (
          <EmptyState title={t('customer.pageEmpty')} />
        ) : null}

        {ready && items.length > 0
          ? items.map((item) => (
              <RequestItemRow
                deleteDisabled={deletingId !== null}
                deleting={deletingId === item.id}
                item={item}
                key={item.id}
                onDelete={onDelete}
                onSelect={onSelect}
                selected={selectedRequestId === item.id}
              />
            ))
          : null}

        {ready && total > 0 ? (
          <div className="mt-1 flex justify-center">
            <Pagination
              current={state.data.page}
              onChange={onGoToPage}
              pageSize={state.data.pageSize}
              showSizeChanger={false}
              size="small"
              total={total}
            />
          </div>
        ) : null}
      </div>
    </DataCard>
  );
}
