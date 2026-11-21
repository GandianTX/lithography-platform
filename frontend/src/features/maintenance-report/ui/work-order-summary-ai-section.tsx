// src/features/maintenance-report/ui/work-order-summary-ai-section.tsx
//
// 工单总结 AI 评价区块（任务 05 真实会话读侧）。
//
// - 只列出服务端返回的「本人工单 + 同一公司 + 所选版本内已有有效回复」的会话；
// - 空列表 = 服务端确认没有可用会话，不强制评分；
// - 查询失败显示「无法确认」并提供重试，绝不当作「确认无会话」；
// - 2026-11-21 需求：不提供「未使用 AI」强制选项；存在适用会话时必须选择并
//   填写评价后才能提交（就绪态经 onReadiness 上报，由核对页控制提交按钮）；
// - 评价绑定会话的不可变内容版本（contentVersion），之后追加消息不影响已保存范围；
// - 已提交（只读）时展示冻结的评价组，不提供修改入口。

import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Input, Rate, Select, Space, Spin, Typography } from 'antd';

import { isGraphQLIngressError } from '@/shared/graphql';
import { useI18n } from '@/shared/i18n';
import { formatDateTimeMinuteText } from '@/shared/ui/format-date-time';

import type {
  MaintenanceReportAiCorrectness,
  MaintenanceReportRecord,
  WorkOrderSummaryAiConversation,
} from '../infrastructure/maintenance-report.types';
import { fetchWorkOrderSummaryAiConversations } from '../infrastructure/maintenance-report-adapter';

/** 页面持有的评价草稿值（null = 未选择会话） */
export type WorkOrderSummaryAiDraftValue = {
  conversationId: number;
  contentVersion: number;
  score: number | null;
  correctness: MaintenanceReportAiCorrectness | null;
  helpfulness: number | null;
  note: string;
};

/**
 * AI 候选查询就绪态：
 * - loading / failed：无法确认会话事实，提交必须被禁止（查询失败不得按无会话提交）；
 * - confirmedEmpty：服务端确认没有适用会话，可以不评分直接提交；
 * - ready：存在适用会话，须选择会话并填写评价后才能提交。
 */
export type WorkOrderSummaryAiReadiness = 'loading' | 'failed' | 'confirmedEmpty' | 'ready';

type CandidatesState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; items: WorkOrderSummaryAiConversation[] };

type Props = {
  repairRequestId: number;
  /** 已落库的报告（无草稿时为 null） */
  saved: MaintenanceReportRecord | null;
  /** 已提交/无编辑权时为只读展示 */
  readOnly: boolean;
  value: WorkOrderSummaryAiDraftValue | null;
  onChange: (value: WorkOrderSummaryAiDraftValue | null) => void;
  /** 候选查询就绪态上报（核对页据此控制提交按钮；只读模式不上报） */
  onReadiness?: (readiness: WorkOrderSummaryAiReadiness) => void;
};

const HELPFULNESS_OPTIONS = [1, 2, 3, 4] as const;
const CORRECTNESS_VALUES: MaintenanceReportAiCorrectness[] = ['CORRECT', 'PARTIAL', 'INCORRECT'];

export function WorkOrderSummaryAiSection({
  repairRequestId,
  saved,
  readOnly,
  value,
  onChange,
  onReadiness,
}: Props) {
  const { t } = useI18n();
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<CandidatesState>({ kind: 'loading' });

  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    void fetchWorkOrderSummaryAiConversations(repairRequestId)
      .then((items) => {
        if (cancelled) return;
        setState({ kind: 'ready', items });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          kind: 'failed',
          message: isGraphQLIngressError(error)
            ? error.userMessage
            : t('maintenanceReport.summaryReview.aiLoadFailed'),
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, repairRequestId, reloadToken]);

  // 就绪态上报：让核对页按「无法确认 ≠ 无会话」的门禁控制提交
  useEffect(() => {
    if (readOnly || onReadiness === undefined) return;
    if (state.kind === 'loading') onReadiness('loading');
    else if (state.kind === 'failed') onReadiness('failed');
    else onReadiness(state.items.length === 0 ? 'confirmedEmpty' : 'ready');
  }, [onReadiness, readOnly, state]);

  const retry = useCallback(() => {
    // 重试由用户事件触发：先回到加载态，再由 effect 发起查询
    setState({ kind: 'loading' });
    setReloadToken((token) => token + 1);
  }, []);

  if (readOnly) {
    return <SavedAiEvaluation record={saved} />;
  }

  if (state.kind === 'loading') {
    return (
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <Spin />
        <Typography.Text type="secondary">
          {t('maintenanceReport.summaryReview.aiLoading')}
        </Typography.Text>
      </Space>
    );
  }

  if (state.kind === 'failed') {
    return (
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <Alert showIcon title={state.message} type="error" />
        <Typography.Text type="secondary">
          {t('maintenanceReport.summaryReview.aiLoadFailedHint')}
        </Typography.Text>
        <Button onClick={retry} size="small">
          {t('maintenanceReport.retry')}
        </Button>
      </Space>
    );
  }

  if (state.items.length === 0) {
    return (
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <Alert showIcon title={t('maintenanceReport.summaryReview.aiEmpty')} type="info" />
        <Typography.Text type="secondary">
          {t('maintenanceReport.summaryReview.aiEmptyHint')}
        </Typography.Text>
      </Space>
    );
  }

  const selectedItem =
    state.items.find((item) => value !== null && item.conversationId === value.conversationId) ??
    null;

  const handleSelect = (conversationId: number): void => {
    const item = state.items.find((candidate) => candidate.conversationId === conversationId);
    if (!item) return;
    // 只在「改选会话」时取该会话当前版本；已保存的旧版本不会被自动升级
    // （页面初始值来自报告冻结的 aiSourceVersion，后续只改评分/说明不会改变范围）
    onChange({
      conversationId: item.conversationId,
      contentVersion: item.contentVersion,
      score: value?.score ?? null,
      correctness: value?.correctness ?? null,
      helpfulness: value?.helpfulness ?? null,
      note: value?.note ?? '',
    });
  };

  return (
    <Space orientation="vertical" size="small" style={{ width: '100%' }}>
      <Typography.Text type="secondary">
        {t('maintenanceReport.summaryReview.aiIntro')}
      </Typography.Text>
      <Select
        aria-label={t('maintenanceReport.summaryReview.aiSelectLabel')}
        options={state.items.map((item) => ({
          value: item.conversationId,
          label: t('maintenanceReport.summaryReview.aiOption', {
            conversationId: item.conversationId,
            version: item.contentVersion,
            replies: item.effectiveReplyCount,
            createdAt: formatDateTimeMinuteText(item.createdAt),
          }),
        }))}
        placeholder={t('maintenanceReport.summaryReview.aiSelectPlaceholder')}
        style={{ minWidth: 360 }}
        value={value?.conversationId}
        onChange={handleSelect}
      />

      {value === null ? (
        <Typography.Text type="secondary">
          {t('maintenanceReport.summaryReview.aiRequired')}
        </Typography.Text>
      ) : (
        <>
          <Typography.Text type="secondary">
            {t('maintenanceReport.summaryReview.aiRange', {
              version: value.contentVersion,
              lastMessageSeq: selectedItem?.lastMessageSeq ?? '—',
            })}
          </Typography.Text>
          <Space wrap size="middle">
            <Space orientation="vertical" size={2}>
              <Typography.Text>{t('maintenanceReport.summaryReview.aiScore')}</Typography.Text>
              <Rate
                allowClear
                count={5}
                value={value.score ?? 0}
                onChange={(next) => onChange({ ...value, score: next === 0 ? null : next })}
              />
            </Space>
            <Space orientation="vertical" size={2}>
              <Typography.Text>
                {t('maintenanceReport.summaryReview.aiCorrectness')}
              </Typography.Text>
              <Select
                allowClear
                aria-label={t('maintenanceReport.summaryReview.aiCorrectness')}
                options={CORRECTNESS_VALUES.map((correctness) => ({
                  value: correctness,
                  label: t(`maintenanceReport.summaryReview.aiCorrectness.${correctness}`),
                }))}
                placeholder={t('maintenanceReport.summaryReview.aiNotPreselected')}
                style={{ minWidth: 160 }}
                value={value.correctness}
                onChange={(next) => onChange({ ...value, correctness: next ?? null })}
              />
            </Space>
            <Space orientation="vertical" size={2}>
              <Typography.Text>
                {t('maintenanceReport.summaryReview.aiHelpfulness')}
              </Typography.Text>
              <Select
                allowClear
                aria-label={t('maintenanceReport.summaryReview.aiHelpfulness')}
                options={HELPFULNESS_OPTIONS.map((level) => ({
                  value: level,
                  label: t(`maintenanceReport.summaryReview.aiHelpfulness.${level}`),
                }))}
                placeholder={t('maintenanceReport.summaryReview.aiNotPreselected')}
                style={{ minWidth: 140 }}
                value={value.helpfulness}
                onChange={(next) => onChange({ ...value, helpfulness: next ?? null })}
              />
            </Space>
          </Space>
          <Input.TextArea
            aria-label={t('maintenanceReport.summaryReview.aiNote')}
            maxLength={2000}
            placeholder={t('maintenanceReport.summaryReview.aiNotePlaceholder')}
            rows={2}
            value={value.note}
            onChange={(event) => onChange({ ...value, note: event.target.value })}
          />
          <Typography.Text type="secondary">
            {t('maintenanceReport.summaryReview.aiScopeHint')}
          </Typography.Text>
        </>
      )}
    </Space>
  );
}

/** 只读展示已冻结的评价组（已提交/无编辑权） */
function SavedAiEvaluation({ record }: { record: MaintenanceReportRecord | null }) {
  const { t } = useI18n();
  if (record === null || record.aiUsage !== 'USED') {
    return (
      <Alert showIcon title={t('maintenanceReport.summaryReview.aiSavedNotUsed')} type="info" />
    );
  }
  return (
    <Space orientation="vertical" size="small" style={{ width: '100%' }}>
      <Typography.Text type="secondary">
        {t('maintenanceReport.summaryReview.aiSavedRange', {
          sourceId: record.aiSourceId ?? '—',
          version: record.aiSourceVersion ?? '—',
        })}
      </Typography.Text>
      <AiRow
        label={t('maintenanceReport.summaryReview.aiScore')}
        value={record.aiScore === null ? '—' : `${record.aiScore} / 5`}
      />
      <AiRow
        label={t('maintenanceReport.summaryReview.aiCorrectness')}
        value={
          record.aiCorrectness === null
            ? '—'
            : t(`maintenanceReport.summaryReview.aiCorrectness.${record.aiCorrectness}`)
        }
      />
      <AiRow
        label={t('maintenanceReport.summaryReview.aiHelpfulness')}
        value={
          record.aiHelpfulness === null
            ? '—'
            : t(
                `maintenanceReport.summaryReview.aiHelpfulness.${
                  record.aiHelpfulness as 1 | 2 | 3 | 4
                }`,
              )
        }
      />
      <AiRow label={t('maintenanceReport.summaryReview.aiNote')} value={record.aiNote ?? '—'} />
    </Space>
  );
}

function AiRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Typography.Text type="secondary">{label}</Typography.Text>
      <div style={{ whiteSpace: 'pre-wrap' }}>{value.trim().length === 0 ? '—' : value}</div>
    </div>
  );
}
