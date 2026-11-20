// src/features/repair-request/ui/customer-repair-request-detail-panel.tsx

import { Alert, Button, Popconfirm, Skeleton, Timeline } from 'antd';
import type { ReactNode } from 'react';

import type { NotifyFeedback } from '@/shared/feedback';
import type { MessageKey } from '@/shared/i18n';
import { useI18n } from '@/shared/i18n';
import { DataCard } from '@/shared/ui/data-card';
import { formatDateTimeMinuteText } from '@/shared/ui/format-date-time';
import { StatusPill } from '@/shared/ui/status-pill';

import { useCustomerRepairOriginalDownload } from '../application/use-customer-repair-original-download';
import type { CustomerRepairRequestDetailState } from '../application/use-customer-repair-request-detail-flow';
import type {
  IntakeAnalysisDisplayState,
  IntakeAnalysisRetryReason,
  IntakeAnalysisStatus,
} from '../infrastructure/repair-request-read.types';

/**
 * 客户工作台右栏维修申请详情面板（PR5 整合工作台；任务 03 第三段扩展）。
 *
 * - 纯展示组件：加载状态机、删除/重试命令与竞态守卫由调用方（工作台）持有的
 *   useCustomerRepairRequestDetailFlow / 列表 hook 承担，本组件不直接发 GraphQL 请求；
 * - 头部集中展示申请编号、接单/处理状态与适用操作（未接单才渲染删除确认，
 *   已接单不预留空按钮位）；
 * - 基础信息用五列摘要条（型号/型号代码/错误码/厂家/创建时间），窄屏两列；
 * - 分区按「原稿 → 本人原件 → 工单进度 → 首析 → 客户可见回复」分层：
 *   工单进度与首析状态是两组独立事实，分开呈现；不放「生成工单」按钮；
 * - 首析展示状态与「重新分析」入口完全按服务端返回的 displayState /
 *   retryEligibility 渲染，前端不再自行组合 FAILED + generation；
 *   防重复最终由服务端原子裁决兜底；
 * - 失败态区分 not-found（warning）与其余失败（error），不伪装成空数据。
 */

export type CustomerRepairRequestDetailPanelProps = {
  deleting: boolean;
  notify: NotifyFeedback;
  /** 提供时显示「返回历史列表」操作（详情路由使用；列表态已在列表中则不传） */
  onBackToList?: () => void;
  onDelete: () => void;
  onRetryAnalysis: () => void;
  retryPending: boolean;
  state: CustomerRepairRequestDetailState;
};

/** 首析展示状态 → 展示（文案键 + 胶囊色）；与工单进度状态色系独立 */
const ANALYSIS_DISPLAY_VIEW: Record<
  IntakeAnalysisDisplayState,
  { labelKey: MessageKey; tone: 'critical' | 'neutral' | 'ok' | 'warn' }
> = {
  QUEUED: { labelKey: 'customer.analysisDisplay.QUEUED', tone: 'neutral' },
  RUNNING: { labelKey: 'customer.analysisDisplay.RUNNING', tone: 'warn' },
  COMPLETED: { labelKey: 'customer.analysisDisplay.COMPLETED', tone: 'ok' },
  FAILED_RETRYABLE: { labelKey: 'customer.analysisDisplay.FAILED_RETRYABLE', tone: 'critical' },
  FAILED_NOT_RETRYABLE: {
    labelKey: 'customer.analysisDisplay.FAILED_NOT_RETRYABLE',
    tone: 'critical',
  },
  NOT_STARTED: { labelKey: 'customer.analysisDisplay.NOT_STARTED', tone: 'neutral' },
  UNAVAILABLE: { labelKey: 'customer.analysisDisplay.UNAVAILABLE', tone: 'neutral' },
};

/** 旧后端/缺字段时的状态回落（仅展示标签，不参与重试资格判定） */
const ANALYSIS_STATUS_FALLBACK_VIEW: Record<
  IntakeAnalysisStatus,
  { labelKey: MessageKey; tone: 'critical' | 'neutral' | 'ok' | 'warn' }
> = {
  WAITING: { labelKey: 'customer.analysisStatus.WAITING', tone: 'neutral' },
  RUNNING: { labelKey: 'customer.analysisStatus.RUNNING', tone: 'warn' },
  SUCCEEDED: { labelKey: 'customer.analysisStatus.SUCCEEDED', tone: 'ok' },
  FAILED: { labelKey: 'customer.analysisStatus.FAILED', tone: 'critical' },
};

/** 不可自助重试时的说明文案键（仅负责文案，判定仍以服务端 reason 为准） */
const RETRY_REASON_HINT: Partial<Record<IntakeAnalysisRetryReason, MessageKey>> = {
  RETRY_ALREADY_USED: 'customer.analysisRetryReason.retryAlreadyUsed',
  LEDGER_INTENT_MISSING: 'customer.analysisRetryReason.ledgerIntentMissing',
  ANALYSIS_NOT_INITIATED: 'customer.analysisRetryReason.analysisNotInitiated',
  FAILURE_NOT_CONFIRMED: 'customer.analysisRetryReason.failureNotConfirmed',
  OWNERSHIP_CONFLICT: 'customer.analysisRetryReason.unavailable',
  NOT_CONVERTED: 'customer.analysisRetryReason.unavailable',
  STATUS_UNKNOWN: 'customer.analysisRetryReason.unavailable',
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

/** 本人报修原件分区：文件名 + 大小 + 授权下载（在途按 fileId 绑定 loading） */
function OriginalFileSection({
  download,
  downloadingFileId,
  file,
}: {
  download: (fileId: string) => Promise<boolean>;
  downloadingFileId: string | null;
  file: { fileId: string; originalFilename: string; byteSize: number };
}) {
  const { t } = useI18n();

  return (
    <SectionBlock label={t('customer.section.originalFile')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-bold break-all text-text">{file.originalFilename}</span>
        <span className="text-xs text-text-tertiary">{file.byteSize} B</span>
        <Button
          loading={downloadingFileId === file.fileId}
          onClick={() => void download(file.fileId)}
          size="small"
        >
          {t('customer.originalFileDownload')}
        </Button>
      </div>
    </SectionBlock>
  );
}

export function CustomerRepairRequestDetailPanel({
  deleting,
  notify,
  onBackToList,
  onDelete,
  onRetryAnalysis,
  retryPending,
  state,
}: CustomerRepairRequestDetailPanelProps) {
  const { t } = useI18n();
  const { downloadingFileId, download } = useCustomerRepairOriginalDownload(notify);

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
  const analysis = detail.intakeAnalysis ?? null;
  // 展示标签与重试入口只读服务端判定：前端不再自行组合 FAILED + generation。
  // 防重复最终仍由后端原子裁决兜底（并发点击不依赖这里的禁用态）。
  const displayView = analysis
    ? (ANALYSIS_DISPLAY_VIEW[analysis.displayState] ??
      ANALYSIS_STATUS_FALLBACK_VIEW[analysis.status] ??
      null)
    : null;
  const canRetryAnalysis = analysis?.retryEligibility.eligible === true;
  const retryHintKey =
    analysis && !canRetryAnalysis ? RETRY_REASON_HINT[analysis.retryEligibility.reason] : undefined;

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
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <SummaryTile label={t('customer.summary.model')}>
            {detail.equipmentModel.modelName}
          </SummaryTile>
          <SummaryTile label={t('customer.summary.modelCode')}>
            {detail.equipmentModel.modelCode}
          </SummaryTile>
          <SummaryTile label={t('customer.summary.errorCode')}>{detail.errorCode}</SummaryTile>
          <SummaryTile label={t('customer.summary.serviceOrganization')}>
            {detail.serviceOrganization?.name ?? '—'}
          </SummaryTile>
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

        {/* 本人报修原件：只读展示 + 授权下载；服务端按「真实绑定到本人原稿」裁决 */}
        {detail.originalFile ? (
          <OriginalFileSection
            download={download}
            downloadingFileId={downloadingFileId}
            file={detail.originalFile}
          />
        ) : null}

        {/* 工单进度：与首析状态分开展示的真实处理事实（旧行缺失按不可确认处理） */}
        <SectionBlock label={t('customer.section.workOrderProgress')}>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-tertiary">
                  {t('customer.progress.handlingStatus')}
                </span>
                {detail.handlingStatus ? (
                  <StatusPill tone={detail.handlingStatus === 'COMPLETED' ? 'ok' : 'warn'}>
                    {t(`status.handlingStatus.${detail.handlingStatus}`)}
                  </StatusPill>
                ) : (
                  <span className="text-text-tertiary">—</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-tertiary">
                  {t('customer.progress.handlingResult')}
                </span>
                <span className="break-words text-text">
                  {detail.handlingResult
                    ? t(`status.handlingResult.${detail.handlingResult}`)
                    : '—'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-tertiary">
                  {t('customer.progress.closureStatus')}
                </span>
                <span className="text-text">
                  {detail.closureStatus === 'CLOSED'
                    ? `${t('customer.progress.closed')} · ${detail.closedAt ? formatDateTimeMinuteText(detail.closedAt) : ''}`
                    : t('customer.progress.open')}
                </span>
              </div>
            </div>
            {detail.closureStatus === 'CLOSED' && detail.closureReason ? (
              <div className="text-[13px] break-words text-text-secondary">
                {t('customer.progress.closureReason')}：{detail.closureReason}
              </div>
            ) : null}
          </div>
        </SectionBlock>

        {/* 首析状态与正文：独立于工单进度的事实组；无原稿关联的旧单整块不渲染 */}
        {analysis ? (
          <SectionBlock
            label={
              <span className="flex flex-wrap items-center gap-2">
                {t('customer.section.analysis')}
                {displayView ? (
                  <StatusPill tone={displayView.tone}>{t(displayView.labelKey)}</StatusPill>
                ) : (
                  <StatusPill tone="neutral">{analysis.status}</StatusPill>
                )}
              </span>
            }
          >
            <div className="flex flex-col gap-2">
              <div className="text-xs text-text-tertiary">
                {t('customer.analysis.generation', { generation: analysis.generation })}
                {analysis.finishedAt
                  ? ` · ${t('customer.analysis.finishedAt')} ${formatDateTimeMinuteText(analysis.finishedAt)}`
                  : ''}
              </div>
              {analysis.outputText ? (
                <pre className="text-sm break-words whitespace-pre-wrap">{analysis.outputText}</pre>
              ) : analysis.displayState === 'COMPLETED' ? null : (
                <div className="text-[13px] text-text-secondary">
                  {t(
                    analysis.displayState === 'NOT_STARTED'
                      ? 'customer.analysis.noRecord'
                      : 'customer.analysis.pendingOutput',
                  )}
                </div>
              )}
              {canRetryAnalysis ? (
                <div>
                  <Button
                    disabled={retryPending}
                    loading={retryPending}
                    onClick={onRetryAnalysis}
                    size="small"
                    type="primary"
                  >
                    {t('customer.analysis.retryButton')}
                  </Button>
                  <div className="mt-1 text-xs text-text-tertiary">
                    {t('customer.analysis.retryHint')}
                  </div>
                </div>
              ) : retryHintKey ? (
                <div className="text-xs text-text-tertiary">{t(retryHintKey)}</div>
              ) : null}
            </div>
          </SectionBlock>
        ) : null}

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
