// src/features/ai-conversation/ui/ai-conversation-panel.tsx

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Modal, Select, Space, Tag, Typography } from 'antd';
import type { UIEvent } from 'react';

import type { MessageKey } from '@/shared/i18n';
import { useI18n } from '@/shared/i18n';

import { AI_QUESTION_MAX_LENGTH } from '../application/use-ai-diagnosis-workspace';
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
  /** 上一次会话创建结果未知（需显式确认继续或放弃，草稿已保留） */
  createUnknown: boolean;
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
  /** 用户确认「继续发送」（承担可能产生重复空会话的风险） */
  onContinueCreate: () => void;
  /** 用户确认「放弃本次创建」（草稿与工单仍保留） */
  onAbandonCreate: () => void;
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

  /**
   * 未知创建结果的确认对话框。
   *
   * 关闭或取消都不解除未知态、不丢草稿；只有用户明确确认才解除阻断，
   * 且确认后仍需用户再次主动发送（不代替用户发送）。
   */
  const [confirmKind, setConfirmKind] = useState<'continue' | 'abandon' | null>(null);
  const openContinueConfirm = useCallback(() => setConfirmKind('continue'), []);
  const openAbandonConfirm = useCallback(() => setConfirmKind('abandon'), []);
  const closeConfirm = useCallback(() => setConfirmKind(null), []);
  const confirmProceed = useCallback(() => {
    if (confirmKind === 'continue') {
      props.onContinueCreate();
    } else if (confirmKind === 'abandon') {
      props.onAbandonCreate();
    }
    setConfirmKind(null);
  }, [confirmKind, props]);

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
      <div className="ai-panel-top">
        <div className="ai-panel-header">
          <Space align="center" size={8}>
            <Text className="ai-panel-title" strong>
              {t('ai.panel.title')}
            </Text>
            {conversation !== null && conversation.turns.length > 0 ? (
              <Text className="ai-turn-count" type="secondary">
                {t('ai.panel.turnCount', { count: conversation.turns.length })}
              </Text>
            ) : null}
          </Space>
          {/* 未知创建结果时不显示「新建对话」：此时它不做新建，只会变成一次
              带风险确认的「放弃本次」，统一在错误区提供明确的两个动作。 */}
          {props.createUnknown ? null : (
            <Button disabled={creating} onClick={props.onNewChat} type="primary">
              {t('ai.panel.newChat')}
            </Button>
          )}
        </div>

        <div className="ai-panel-work-order">
          <Text className="ai-panel-work-order-label" type="secondary">
            {t('ai.panel.workOrderLabel')}
          </Text>
          <div className="ai-work-order-select">
            <Select
              allowClear
              aria-label={t('ai.panel.workOrderLabel')}
              disabled={workOrderLocked}
              loading={props.workOrderStatus === 'loading'}
              notFoundContent={workOrderNotFound}
              onChange={(value: number | null | undefined) =>
                props.onWorkOrderChange(value ?? null)
              }
              onPopupScroll={(event) => {
                const element = event.currentTarget;
                if (element.scrollHeight - element.scrollTop - element.clientHeight < 24) {
                  props.onLoadMoreWorkOrders();
                }
              }}
              options={props.workOrders.map((option) => ({
                label: option.label,
                value: option.id,
              }))}
              placeholder={t('ai.panel.workOrderPlaceholder')}
              popupMatchSelectWidth={320}
              showSearch
              size="small"
              value={selectedWorkOrder ?? undefined}
            />
          </div>
          <Text
            className="ai-work-order-hint"
            title={
              conversation !== null
                ? t('ai.panel.workOrderLockedHint')
                : t('ai.panel.workOrderStandaloneHint')
            }
            type="secondary"
          >
            {conversation !== null
              ? t('ai.panel.workOrderLockedHint')
              : t('ai.panel.workOrderStandaloneHint')}
          </Text>
        </div>
      </div>

      <ConversationThread
        activeQuestionUuid={props.activeQuestionUuid}
        conversation={conversation}
        generating={generating}
        key={conversation?.id ?? 'draft'}
        onRefresh={props.onRefreshTurn}
        onRetry={props.onRetryTurn}
        retrying={props.retrying}
      />

      <div className="ai-compose">
        {/* 未知态的解除入口不依赖错误文案：即便别的操作清空了提示，
            「继续发送 / 放弃本次」也必须始终可见，否则用户会被困在无法解除的未知态。 */}
        {props.errorMessage !== null || props.createUnknown ? (
          <div className="ai-compose-alert" role="alert">
            {props.errorMessage}
            {props.createUnknown ? (
              // 结果未知：会话列表无法证明本次创建是否成功，服务端仍可能完成该请求。
              // 只提供显式、可取消的确认操作，且都不代替用户发送；草稿始终保留。
              <>
                <Space size={8}>
                  <Button onClick={openContinueConfirm} size="small">
                    {t('ai.panel.continueCreate')}
                  </Button>
                  <Button onClick={openAbandonConfirm} size="small">
                    {t('ai.panel.abandonCreate')}
                  </Button>
                </Space>
                <Text type="secondary">{t('ai.panel.createUnknownHint')}</Text>
              </>
            ) : null}
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
          autoSize={{ maxRows: 4, minRows: 3 }}
          onChange={(event) => props.onDraftChange(event.target.value)}
          maxLength={AI_QUESTION_MAX_LENGTH}
          onPressEnter={(event) => {
            // 中文/日文输入法确认候选词时的回车不是「发送」
            if (event.nativeEvent.isComposing) {
              return;
            }
            if (event.shiftKey) {
              return;
            }
            event.preventDefault();
            props.onSubmit();
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

      <Modal
        cancelButtonProps={{ autoInsertSpace: false }}
        cancelText={t('ai.panel.confirmCancel')}
        okText={
          confirmKind === 'abandon'
            ? t('ai.panel.confirmAbandonOk')
            : t('ai.panel.confirmContinueOk')
        }
        onCancel={closeConfirm}
        onOk={confirmProceed}
        okButtonProps={{ autoInsertSpace: false }}
        open={confirmKind !== null}
        title={
          confirmKind === 'abandon'
            ? t('ai.panel.confirmAbandonTitle')
            : t('ai.panel.confirmContinueTitle')
        }
      >
        <p>
          {confirmKind === 'abandon'
            ? t('ai.panel.confirmAbandonBody')
            : t('ai.panel.confirmContinueBody')}
        </p>
      </Modal>
    </aside>
  );
}

type ConversationThreadProps = {
  conversation: AiConversationDetail | null;
  activeQuestionUuid: string | null;
  generating: boolean;
  retrying: boolean;
  onRetry: (questionUuid: string) => void;
  onRefresh: (questionUuid: string) => void;
};

/**
 * 会话区：只有消息流滚动，输入区常驻可达。
 *
 * 按会话 key 挂载：切换会话即回到「跟随最新」，另一个会话的回看位置不会带进来；
 * 同一会话内用户上滚回看时停止自动贴底，并给出「回到最新」。
 */
function ConversationThread(props: ConversationThreadProps) {
  const { t } = useI18n();
  const threadRef = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);
  const turns = props.conversation?.turns ?? [];

  useEffect(() => {
    if (!pinned) {
      return;
    }
    const element = threadRef.current;
    if (element === null) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [pinned, props.generating, turns.length]);

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

  return (
    <div className="ai-thread-shell">
      <div
        aria-label={t('ai.panel.threadLabel')}
        className="ai-thread"
        onScroll={handleScroll}
        ref={threadRef}
        role="log"
      >
        {turns.length === 0 ? (
          <div className="ai-thread-empty">{t('ai.panel.empty')}</div>
        ) : (
          turns.map((turn) => (
            <TurnBlock
              activeQuestionUuid={props.activeQuestionUuid}
              key={turn.questionUuid}
              onRefresh={props.onRefresh}
              onRetry={props.onRetry}
              retrying={props.retrying}
              turn={turn}
            />
          ))
        )}
      </div>

      {pinned ? null : (
        <button className="ai-thread-jump" onClick={scrollToLatest} type="button">
          {t('ai.panel.toLatest')}
        </button>
      )}
    </div>
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
