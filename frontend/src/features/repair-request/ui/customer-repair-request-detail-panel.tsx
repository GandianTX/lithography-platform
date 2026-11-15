// src/features/repair-request/ui/customer-repair-request-detail-panel.tsx

import { Alert, Button, Popconfirm, Skeleton, Timeline } from 'antd';
import type { ReactNode } from 'react';

import { useI18n } from '@/shared/i18n';
import { DataCard } from '@/shared/ui/data-card';
import { formatDateTimeMinuteText } from '@/shared/ui/format-date-time';
import { StatusPill } from '@/shared/ui/status-pill';

import type { CustomerRepairRequestDetailState } from '../application/use-customer-repair-request-detail-flow';

/**
 * 客户工作台右栏维修申请详情面板（PR5 整合工作台）。
 *
 * - 纯展示组件：加载状态机、删除命令与竞态守卫由调用方（工作台）持有的
 *   useCustomerRepairRequestDetailFlow / 列表 hook 承担，本组件不感知 adapter；
 * - 头部集中展示申请编号、接单/处理状态与适用操作（未接单才渲染删除确认，
 *   已接单不预留空按钮位）；
 * - 基础信息用四列摘要条（型号/型号代码/错误码/创建时间），窄屏两列；
 * - 故障描述、故障正文、工程师回复按层级纵向分组；无回复时整块不渲染；
 * - 失败态区分 not-found（warning）与其余失败（error），不伪装成空数据。
 */

export type CustomerRepairRequestDetailPanelProps = {
  deleting: boolean;
  /** 提供时显示「返回历史列表」操作（详情路由使用；列表态已在列表中则不传） */
  onBackToList?: () => void;
  onDelete: () => void;
  state: CustomerRepairRequestDetailState;
};

/** 摘要条信息块：gkj .detail-section 语言（12px 圆角描边块 + 9px 大写标签 + 13px 值） */
function SummaryTile({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-bg-container p-3.5">
      <div className="text-[9px] font-extrabold tracking-[0.12em] text-text-tertiary uppercase">
        {label}
      </div>
      <div className="mt-[5px] text-[13px] font-bold break-words text-text">{children}</div>
    </div>
  );
}

function SectionBlock({ children, label }: { children: ReactNode; label: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-bg-container p-3.5">
      <h4 className="text-[9px] font-extrabold tracking-[0.12em] text-text-tertiary uppercase">
        {label}
      </h4>
      <div className="mt-2">{children}</div>
    </section>
  );
}

export function CustomerRepairRequestDetailPanel({
  deleting,
  onBackToList,
  onDelete,
  state,
}: CustomerRepairRequestDetailPanelProps) {
  const { t } = useI18n();

  if (state.status === 'loading') {
    return (
      <DataCard title={t('customer.detailCardTitle')}>
        <Skeleton active paragraph={{ rows: 8 }} />
      </DataCard>
    );
  }

  if (state.status === 'failed') {
    return (
      <DataCard title={t('customer.detailCardTitle')}>
        <Alert
          action={
            onBackToList ? (
              <Button onClick={onBackToList} size="small">
                {t('customer.backToList')}
              </Button>
            ) : null
          }
          showIcon
          title={state.message}
          type={state.notFound ? 'warning' : 'error'}
        />
      </DataCard>
    );
  }

  const { detail } = state;

  return (
    <DataCard
      extra={
        detail.isAccepted ? null : (
          <Popconfirm
            cancelText={t('common.cancel')}
            okButtonProps={{ loading: deleting }}
            okText={t('common.confirmDelete')}
            onConfirm={onDelete}
            title={t('common.deleteRequestTitle')}
          >
            <Button danger disabled={deleting} type="primary">
              {t('customer.deleteRequestButton')}
            </Button>
          </Popconfirm>
        )
      }
      title={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono break-all">{detail.requestNo}</span>
          <StatusPill tone={detail.isAccepted ? 'ok' : 'warn'}>
            {detail.isAccepted ? t('customer.statusAccepted') : t('customer.statusPending')}
          </StatusPill>
          {detail.isAccepted && detail.acceptedAt ? (
            <span className="text-xs font-normal text-text-tertiary">
              {formatDateTimeMinuteText(detail.acceptedAt)}
            </span>
          ) : null}
          {detail.latestResolutionStatus ? (
            <StatusPill tone={detail.latestResolutionStatus === 'RESOLVED' ? 'ok' : 'warn'}>
              {t(`status.resolution.${detail.latestResolutionStatus}`)}
            </StatusPill>
          ) : null}
        </span>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SummaryTile label={t('customer.summary.model')}>
            {detail.equipmentModel.modelName}
          </SummaryTile>
          <SummaryTile label={t('customer.summary.modelCode')}>
            {detail.equipmentModel.modelCode}
          </SummaryTile>
          <SummaryTile label={t('customer.summary.errorCode')}>{detail.errorCode}</SummaryTile>
          <SummaryTile label={t('customer.summary.createdAt')}>
            {formatDateTimeMinuteText(detail.createdAt)}
          </SummaryTile>
        </div>

        <SectionBlock label={t('customer.section.faultDescription')}>
          <div className="text-[13px] break-words text-text">{detail.faultDescription}</div>
        </SectionBlock>

        {/* 故障正文按纯文本渲染（React 文本转义边界），不切换为原始 HTML */}
        <SectionBlock label={t('customer.section.faultContent')}>
          <pre className="text-sm break-words whitespace-pre-wrap">{detail.contentMd}</pre>
        </SectionBlock>

        {/* 0 条回复时整个回复模块（含标题、计数、占位）都不渲染 */}
        {detail.responses.length > 0 ? (
          <SectionBlock label={t('customer.section.responses', { count: detail.responses.length })}>
            <Timeline
              items={detail.responses.map((response) => ({
                // AntD v6：items.children 已弃用（运行时告警），改用 items.content
                content: (
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{response.engineerNickname}</span>
                      <StatusPill tone={response.resolutionStatus === 'RESOLVED' ? 'ok' : 'warn'}>
                        {t(`status.resolution.${response.resolutionStatus}`)}
                      </StatusPill>
                      <span className="text-xs text-text-secondary">
                        {formatDateTimeMinuteText(response.createdAt)}
                      </span>
                    </div>
                    <div className="text-sm break-words">{response.responseText}</div>
                  </div>
                ),
                key: response.id,
              }))}
            />
          </SectionBlock>
        ) : null}

        {onBackToList ? (
          <div>
            <Button onClick={onBackToList}>{t('customer.backToList')}</Button>
          </div>
        ) : null}
      </div>
    </DataCard>
  );
}
