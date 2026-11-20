// src/features/ai-conversation/ui/ai-conversation-panel.tsx

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Select, Space, Tag, Typography } from 'antd';
import type { UIEvent } from 'react';

import type { MessageKey } from '@/shared/i18n';
import { useI18n } from '@/shared/i18n';

import type {
  AiConversationDetail,
  AiConversationTurn,
  AiMessageAnalysisStatus,
} from '../infrastructure/ai-conversation.types';

const { Text } = Typography;

/** 工单候选（只做展示与选择，归属与绑定由后端最终校验） */
export type AiWorkOrderOption = { readonly id: number; readonly label: string };

export type AiConversationPanelProps = {
  conversation: AiConversationDetail | null;
  activeQuestionUuid: string | null;
  generating: boolean;
  creating: boolean;
  submitting: boolean;
  retrying: boolean;
  draft: string;
  errorMessage: string | null;
  noticeMessage: string | null;
  /** 草稿态下已选工单；会话已存在时以 conversation.requestId 为准 */
  workOrderId: number | null;
  workOrders: readonly AiWorkOrderOption[];
  workOrderStatus: 'loading' | 'ready' | 'failed';
  workOrderMessage: string | null;
  canExportPdf: boolean;
  exporting: boolean;
  onDraftChange: (value: string) => void;
  onWorkOrderChange: (requestId: number | null) => void;
  onLoadMoreWorkOrders: () => void;
  onReloadWorkOrders: () => void;
  onNewChat: () => void;
  onSubmit: () => void;
  onRetryTurn: (questionUuid: string) => void;
  onRefreshTurn: (questionUuid: string) => void;
  onExportPdf: () => void;
};

const TURN_STATUS_KEY: Record<AiMessageAnalysisStatus, MessageKey> = {
  PENDING: 'ai.panel.turnStatus.pending',
  RUNNING: 'ai.panel.turnStatus.running',
  SUCCEEDED: 'ai.panel.turnStatus.succeeded',
  FAILED: 'ai.panel.turnStatus.failed',
};

/** 面板固定三段：头部（新建/工单）、会话、底部输入；会话区独立滚动 */
export function AiConversationPanel(props: AiConversationPanelProps) {
  const { t } = useI18n();
  const { conversation, draft, generating, creating, submitting } = props;

  const threadRef = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);

  // 跟随最新：用户没有主动上滚时才自动贴底，避免打断回看
  useEffect(() => {
    if (!pinned) {
      return;
    }
    const element = threadRef.current;
    if (element === null) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [conversation?.id, conversation?.turns.length, generating, pinned]);

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 32);
  }, []);

  const scrollToLatest = useCallback(() => {
    const element = threadRef.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
    setPinned(true);
  }, []);

  // 生成中允许继续提问（后端按轮次受理）；只锁提交与创建在飞
  const busy = submitting || creating;
  const workOrderLocked = conversation !== null || creating;
  const selectedWorkOrder = conversation?.requestId ?? props.workOrderId;

  const workOrderNotFound =
    props.workOrderStatus === 'loading' ? (
      <div className="ai-work-order-state">{t('common.loading')}</div>
    ) : props.workOrderStatus === 'failed' ? (
      <div className="ai-work-order-state">
        <Text type="secondary">{props.workOrderMessage ?? t('ai.panel.workOrderLoadFailed')}</Text>
        <Button onClick={props.onReloadWorkOrders} size="small" type="link">
          {t('ai.panel.workOrderRetry')}
        </Button>
      </div>
    ) : (
      <div className="ai-work-order-state">{t('ai.panel.workOrderEmpty')}</div>
    );

  return (
    <aside aria-label={t('ai.panel.regionLabel')} className="ai-panel">
      <div className="ai-panel-header">
        <Space align="center" size={8}>
          <Text strong>{t('ai.panel.title')}</Text>
          {conversation !== null && conversation.turns.length > 0 ? (
            <Text className="ai-turn-count" type="secondary">
              {t('ai.panel.turnCount', { count: conversation.turns.length })}
            </Text>
          ) : null}
        </Space>
        <Button disabled={creating} onClick={props.onNewChat} size="small">
          {t('ai.panel.newChat')}
        </Button>
      </div>

      <div className="ai-panel-work-order">
        <Text type="secondary">{t('ai.panel.workOrderLabel')}</Text>
        <div className="ai-work-order-select">
          <Select
            allowClear
            aria-label={t('ai.panel.workOrderLabel')}
            disabled={workOrderLocked}
            loading={props.workOrderStatus === 'loading'}
            notFoundContent={workOrderNotFound}
            onChange={(value: number | null | undefined) => props.onWorkOrderChange(value ?? null)}
            onPopupScroll={(event) => {
              const element = event.currentTarget;
              if (element.scrollHeight - element.scrollTop - element.clientHeight < 24) {
                props.onLoadMoreWorkOrders();
              }
            }}
            options={props.workOrders.map((option) => ({ label: option.label, value: option.id }))}
            placeholder={t('ai.panel.workOrderPlaceholder')}
            popupMatchSelectWidth={320}
            showSearch
            size="small"
            value={selectedWorkOrder ?? undefined}
          />
        </div>
        <Text className="ai-work-order-hint" type="secondary">
          {conversation !== null
            ? t('ai.panel.workOrderLockedHint')
            : t('ai.panel.workOrderStandaloneHint')}
        </Text>
      </div>

      <div
        aria-label={t('ai.panel.threadLabel')}
        className="ai-thread"
        onScroll={handleScroll}
        ref={threadRef}
        role="log"
      >
        {conversation === null || conversation.turns.length === 0 ? (
          <div className="ai-thread-empty">{t('ai.panel.empty')}</div>
        ) : (
          conversation.turns.map((turn) => (
            <TurnBlock
              activeQuestionUuid={props.activeQuestionUuid}
              key={turn.questionUuid}
              onRefresh={props.onRefreshTurn}
              onRetry={props.onRetryTurn}
              retrying={props.retrying}
              turn={turn}
            />
          ))
        )}
      </div>

      {!pinned ? (
        <button className="ai-thread-jump" onClick={scrollToLatest} type="button">
          {t('ai.panel.toLatest')}
        </button>
      ) : null}

      <div className="ai-compose">
        {props.errorMessage !== null ? (
          <div className="ai-compose-alert" role="alert">
            {props.errorMessage}
          </div>
        ) : null}
        {props.noticeMessage !== null ? (
          <div className="ai-compose-notice" role="status">
            {props.noticeMessage}
          </div>
        ) : null}
        {generating ? <p className="ai-progress">{t('ai.panel.generating')}</p> : null}

        <Input.TextArea
          aria-label={t('ai.panel.composeLabel')}
          autoSize={{ maxRows: 4, minRows: 2 }}
          onChange={(event) => props.onDraftChange(event.target.value)}
          onPressEnter={(event) => {
            if (!event.shiftKey) {
              event.preventDefault();
              props.onSubmit();
            }
          }}
          placeholder={t('ai.panel.composePlaceholder')}
          showCount
          value={draft}
        />

        <div className="ai-compose-actions">
          <Button
            disabled={!props.canExportPdf || props.exporting}
            loading={props.exporting}
            onClick={props.onExportPdf}
            size="small"
          >
            {t('ai.panel.exportPdf')}
          </Button>
          <span className="ai-send">
            <Button
              disabled={busy || draft.trim().length === 0}
              loading={submitting}
              onClick={props.onSubmit}
              type="primary"
            >
              {t('ai.panel.send')}
            </Button>
          </span>
        </div>
      </div>
    </aside>
  );
}

type TurnBlockProps = {
  turn: AiConversationTurn;
  activeQuestionUuid: string | null;
  retrying: boolean;
  onRetry: (questionUuid: string) => void;
  onRefresh: (questionUuid: string) => void;
};

function TurnBlock({ turn, activeQuestionUuid, retrying, onRetry, onRefresh }: TurnBlockProps) {
  const { t } = useI18n();
  const status = turn.analysisStatus;
  const isFailed = status === 'FAILED';
  const isPending = status === 'PENDING' || status === 'RUNNING';
  const isActive = turn.questionUuid === activeQuestionUuid;

  return (
    <section aria-label={t('ai.panel.turnRegionLabel')} className="ai-turn">
      <div className="ai-turn-meta">
        {turn.turnNo !== null ? (
          <Text className="ai-turn-meta-no" type="secondary">
            {t('ai.panel.turnNo', { count: turn.turnNo })}
          </Text>
        ) : null}
        {status !== null ? <Tag color={tagColor(status)}>{t(TURN_STATUS_KEY[status])}</Tag> : null}
      </div>

      {turn.question !== null ? (
        <div className="ai-message ai-message--mine">
          <p>{turn.question.text}</p>
        </div>
      ) : null}

      {turn.answer !== null ? (
        <div className="ai-message">
          <p>{turn.answer.text}</p>
        </div>
      ) : isPending ? (
        <div className="ai-message ai-message--pending">
          <p>{t('ai.panel.answerPending')}</p>
        </div>
      ) : isFailed ? (
        <div className="ai-turn-failure">
          <Text type="danger">{turn.failureReason ?? t('ai.panel.answerFailed')}</Text>
          <Space size={4}>
            <Button
              disabled={retrying}
              loading={retrying && isActive}
              onClick={() => onRetry(turn.questionUuid)}
              size="small"
            >
              {t('ai.panel.retry')}
            </Button>
            <Button onClick={() => onRefresh(turn.questionUuid)} size="small">
              {t('ai.panel.refresh')}
            </Button>
          </Space>
        </div>
      ) : null}
    </section>
  );
}

function tagColor(status: AiMessageAnalysisStatus): string {
  if (status === 'SUCCEEDED') {
    return 'green';
  }
  if (status === 'FAILED') {
    return 'red';
  }
  if (status === 'RUNNING') {
    return 'blue';
  }
  return 'default';
}
