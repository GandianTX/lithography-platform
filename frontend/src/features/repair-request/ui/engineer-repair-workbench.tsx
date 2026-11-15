// src/features/repair-request/ui/engineer-repair-workbench.tsx

/**
 * 工程师首页工作台（视觉结构参照 gkj.html #profile-page 的左右工作台语言，
 * 不复制其演示数据、固定数组与无数据来源的字段）。
 *
 * - Provider 持有唯一一份工作台读模型（最近待接单 + 待接单总数 + 我的接单总数）：
 *   页头真实统计胶囊与工作台主体共用同一次查询，不建第二套读接口；
 * - 左侧「最近待接单」+ 右侧「选中申请」联动，数据全部来自真实列表读协议；
 * - 右栏按申请头 / 设备与时间 / 客户与接单 / 处理状态分区组织，
 *   只展示列表项已有的展示字段，没有来源的字段一律不渲染；
 * - 加载 / 失败（可重试）/ 无待接单空态复用 PR1 公共状态组件；
 * - 状态胶囊与时间格式化复用切片内唯一实现（与列表、详情一致）；
 * - AI 故障诊断没有正式路由，不渲染任何相关入口或占位。
 */

import { createContext, type ReactNode, useContext } from 'react';
import { Button } from 'antd';
import { useNavigate } from 'react-router';

import { useI18n } from '@/shared/i18n';
import { DataCard } from '@/shared/ui/data-card';
import { EmptyState } from '@/shared/ui/empty-state';
import { ErrorState } from '@/shared/ui/error-state';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { LoadingState } from '@/shared/ui/loading-state';
import { StatusPill } from '@/shared/ui/status-pill';

import { useEngineerRepairWorkbench } from '../application/use-engineer-repair-workbench';
import type { EngineerRepairRequestListItem } from '../infrastructure/engineer-repair-request.types';

import { ENGINEER_REPAIR_REQUEST_DETAIL_PATH } from './engineer-repair-request-paths';
import { AcceptanceViewStatusTag, ResolutionTag } from './repair-request-status-tags';

type EngineerWorkbenchValue = ReturnType<typeof useEngineerRepairWorkbench>;

const EngineerWorkbenchContext = createContext<EngineerWorkbenchValue | null>(null);

/**
 * 工作台读模型 Provider：页头统计与工作台主体必须共用同一份数据，
 * 以免页头另开一次同口径查询（第二套读来源）。
 */
export function EngineerRepairWorkbenchProvider({ children }: { children: ReactNode }) {
  const workbench = useEngineerRepairWorkbench();

  return (
    <EngineerWorkbenchContext.Provider value={workbench}>
      {children}
    </EngineerWorkbenchContext.Provider>
  );
}

function useEngineerWorkbenchValue(): EngineerWorkbenchValue {
  const value = useContext(EngineerWorkbenchContext);

  if (!value) {
    throw new Error('工程师工作台组件必须在 EngineerRepairWorkbenchProvider 内渲染。');
  }

  return value;
}

/**
 * 页头真实统计（PR1 PageHeader 的 extra 位）：
 * 待接单总数取 AVAILABLE 查询返回的 total（不是首页最多 N 条的条目数），
 * 我的接单取 MINE 查询返回的 total；加载中/失败时不渲染任何数字，
 * 避免展示误导性固定值（不显示「—」冒充真实数量）。
 */
export function EngineerWorkbenchHeaderStats() {
  const { t } = useI18n();
  const { state } = useEngineerWorkbenchValue();

  if (state.status !== 'ready') {
    return null;
  }

  return (
    <>
      <StatusPill tone={state.availableTotal > 0 ? 'warn' : 'neutral'}>
        <span>{t('workbench.headerPending')}</span>
        <span>{state.availableTotal}</span>
      </StatusPill>
      <StatusPill tone="neutral">
        <span>{t('workbench.headerMine')}</span>
        <span>{state.mineTotal}</span>
      </StatusPill>
    </>
  );
}

/** 右栏信息块：原型 .detail-section 的 12px 圆角描边块 + 9px 大写标签 + 13px 值 */
function DetailSection({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-bg-container p-3.5">
      <div className="text-[9px] font-extrabold tracking-[0.12em] text-text-tertiary uppercase">
        {label}
      </div>
      <div className="mt-[5px] text-[13px] font-bold wrap-break-word text-text">{children}</div>
    </div>
  );
}

/** 最近待接单条目按钮：整行可点，选中态由 aria-current 表达（三态交互色见
    index.css `.activity-item`，取值登记在 gkj-visual-baseline.md 2.4 节）；
    字级对照原型 .activity-request（编号/标题 11px、提交时间 9px） */
function RecentItemButton({
  item,
  selected,
  onSelect,
}: {
  item: EngineerRepairRequestListItem;
  selected: boolean;
  onSelect: (id: number) => void;
}) {
  const { t } = useI18n();

  return (
    <button
      aria-current={selected ? 'true' : undefined}
      className="activity-item flex w-full flex-col gap-1 px-3 py-[11px] text-left"
      onClick={() => onSelect(item.id)}
      type="button"
    >
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="activity-item-code font-mono text-[11px] font-bold">{item.requestNo}</span>
        <AcceptanceViewStatusTag viewStatus={item.acceptanceViewStatus} />
      </span>
      <span className="text-[11px] font-bold text-text">{`${item.equipmentModel.modelName}（${item.equipmentModel.modelCode}）· ${item.errorCode}`}</span>
      <span className="flex items-center justify-between gap-2 text-[9px] text-text-tertiary">
        <span>{t('workbench.submittedAt')}</span>
        <span>{formatDateTimeText(item.createdAt)}</span>
      </span>
    </button>
  );
}

export function EngineerRepairWorkbench() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { state, selectedItem, select, reload } = useEngineerWorkbenchValue();

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(260px,0.72fr)_minmax(0,1.9fr)]">
      <DataCard title={t('workbench.recent')}>
        <div className="flex flex-col gap-2">
          {state.status === 'loading' ? (
            <LoadingState label={t('workbench.loadingRecent')} />
          ) : null}

          {state.status === 'failed' ? (
            <ErrorState
              action={
                <Button onClick={() => void reload()} size="small">
                  {t('common.retry')}
                </Button>
              }
              title={state.message}
            />
          ) : null}

          {state.status === 'ready' && state.recentItems.length === 0 ? (
            <EmptyState title={t('workbench.emptyRecent')} />
          ) : null}

          {state.status === 'ready' && state.recentItems.length > 0
            ? state.recentItems.map((item) => (
                <RecentItemButton
                  item={item}
                  key={item.id}
                  onSelect={select}
                  selected={selectedItem?.id === item.id}
                />
              ))
            : null}
        </div>
      </DataCard>

      <DataCard
        extra={
          selectedItem ? (
            <AcceptanceViewStatusTag viewStatus={selectedItem.acceptanceViewStatus} />
          ) : null
        }
        title={
          <span className="flex flex-col gap-0.5">
            <span className="text-[9px] font-bold tracking-[0.15em] text-text-tertiary uppercase">
              {t('workbench.eyebrow')}
            </span>
            <span>{selectedItem ? selectedItem.requestNo : t('workbench.selectedSummary')}</span>
          </span>
        }
      >
        {selectedItem ? (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <DetailSection label={t('workbench.model')}>
                {`${selectedItem.equipmentModel.modelName}（${selectedItem.equipmentModel.modelCode}）`}
              </DetailSection>
              <DetailSection label={t('workbench.errorCode')}>
                {selectedItem.errorCode}
              </DetailSection>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <DetailSection label={t('workbench.submittedAt')}>
                {formatDateTimeText(selectedItem.createdAt)}
              </DetailSection>
              <DetailSection label={t('workbench.resolutionStatus')}>
                <ResolutionTag status={selectedItem.latestResolutionStatus} />
              </DetailSection>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <DetailSection label={t('workbench.customer')}>
                <span className="flex flex-col gap-1">
                  <span>{selectedItem.customerNickname}</span>
                  <span className="font-normal text-text-secondary text-xs">
                    {selectedItem.customerCompanyName ?? '—'}
                  </span>
                </span>
              </DetailSection>
              <DetailSection label={t('workbench.acceptedEngineer')}>
                <span className="flex flex-col gap-1">
                  <span>{selectedItem.acceptedEngineerNickname ?? '—'}</span>
                  <span className="font-normal text-text-secondary text-xs">
                    {selectedItem.acceptedAt
                      ? formatDateTimeText(selectedItem.acceptedAt)
                      : t('workbench.notAccepted')}
                  </span>
                </span>
              </DetailSection>
            </div>

            <div>
              <Button
                onClick={() => navigate(`${ENGINEER_REPAIR_REQUEST_DETAIL_PATH}${selectedItem.id}`)}
                type="primary"
              >
                {t('workbench.viewDetail')}
              </Button>
            </div>
          </div>
        ) : (
          <EmptyState title={t('workbench.selectHint')} />
        )}
      </DataCard>
    </div>
  );
}
