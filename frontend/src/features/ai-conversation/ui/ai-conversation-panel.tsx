// src/features/ai-conversation/ui/ai-conversation-panel.tsx
// 右侧「诊断对话」面板（任务 05 · S3）
//
// 行为要点：
// - 生成中 / 失败 / 图形降级分别有独立提示（不与普通加载混同）；
// - 失败轮次提供「重试本轮」入口（沿用同一问题 UUID，不新增用户问题）；
// - 提交失败时保留输入；
// - 工单来源：新建会话时可选关联本公司有权工单；会话绑定后不可改挂。

import { Alert, Button, Empty, Input, InputNumber, Tag } from 'antd';

import type { MessageKey } from '@/shared/i18n';
import { useI18n } from '@/shared/i18n';

import type {
  AiConversationDetail,
  AiConversationTurn,
  AiMessageAnalysisStatus,
} from '../infrastructure/ai-conversation.types';

export type AiWorkOrderOption = {
  readonly id: number;
  readonly label: string;
};

export type AiConversationPanelProps = {
  readonly conversation: AiConversationDetail | null;
  readonly activeQuestionUuid: string | null;
  readonly generating: boolean;
  /** U05：会话创建中——锁定「新建对话」与工单输入，避免待选值与服务端事实不一致 */
  readonly creating: boolean;
  readonly submitting: boolean;
  readonly retrying: boolean;
  readonly draft: string;
  readonly errorMessage: string | null;
  readonly noticeMessage: string | null;
  readonly linkedRequestId: number | null;
  readonly onDraftChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onRetry: () => void;
  /** F03：逐轮重试入口，参数为该轮原问题 UUID */
  readonly onRetryTurn: (questionUuid: string) => void;
  /** 正在重试的具体轮次（用于逐轮 loading） */
  readonly retryingQuestionUuid: string | null;
  /** F03：状态查询失败后的显式重查入口 */
  readonly onRefreshTurn: () => void;
  readonly onNewChat: () => void;
  readonly onOpenHistory: () => void;
  readonly onExportPdf: () => void;
  readonly exporting: boolean;
  readonly onWorkOrderChange: (requestId: number | null) => void;
};

const STATUS_COLORS: Record<AiMessageAnalysisStatus, string> = {
  PENDING: 'gold',
  RUNNING: 'blue',
  SUCCEEDED: 'green',
  FAILED: 'red',
};

const STATUS_LABEL_KEYS: Record<AiMessageAnalysisStatus, MessageKey> = {
  PENDING: 'ai.status.PENDING',
  RUNNING: 'ai.status.RUNNING',
  SUCCEEDED: 'ai.status.SUCCEEDED',
  FAILED: 'ai.status.FAILED',
};

export function AiConversationPanel({
  activeQuestionUuid,
  conversation,
  creating,
  draft,
  errorMessage,
  generating,
  linkedRequestId,
  exporting,
  noticeMessage,
  onDraftChange,
  onExportPdf,
  onNewChat,
  onOpenHistory,
  onRefreshTurn,
  onRetry,
  onRetryTurn,
  onSubmit,
  onWorkOrderChange,
  retrying,
  retryingQuestionUuid,
  submitting,
}: AiConversationPanelProps) {
  const { t } = useI18n();
  const turns = conversation?.turns ?? [];
  // U05：已绑定会话时以服务端事实为准；未选中会话时才展示用户待选的工单
  const workOrderValue = conversation?.requestId ?? linkedRequestId ?? null;
  const activeTurn = turns.find((turn) => turn.questionUuid === activeQuestionUuid) ?? null;
  const canRetry = activeTurn?.analysisStatus === 'FAILED' && activeTurn.answer === null;
  // 生成中仍允许继续提问（后端按轮次并行受理，迟到响应由前端隔离）
  const busy = submitting || retrying;

  return (
    <section aria-label={t('ai.panel.label')} className="ai-panel">
      <header className="ai-panel-header">
        <div className="flex items-center gap-2">
          <h2 className="m-0 text-base font-semibold text-text-primary">{t('ai.panel.title')}</h2>
          {/* V44：卡头展示轮次计数，便于判断会话进度 */}
          <Tag>{t('ai.panel.turnCount', { count: turns.length })}</Tag>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={onOpenHistory} size="small">
            {t('ai.panel.history')}
          </Button>
          <Button
            disabled={conversation === null}
            loading={exporting}
            onClick={onExportPdf}
            size="small"
          >
            {t('ai.panel.exportPdf')}
          </Button>
          <Button
            disabled={creating}
            loading={creating}
            onClick={onNewChat}
            size="small"
            type="primary"
          >
            {t('ai.panel.newChat')}
          </Button>
        </div>
      </header>

      <label className="flex flex-col gap-1 text-xs text-text-secondary">
        <span>{t('ai.panel.workOrderLabel')}</span>
        <InputNumber
          controls={false}
          disabled={conversation !== null || creating}
          min={1}
          onChange={(value) => onWorkOrderChange(typeof value === 'number' ? value : null)}
          placeholder={t('ai.panel.workOrderPlaceholder')}
          value={workOrderValue ?? undefined}
        />
        <span className="text-xs text-text-tertiary">{t('ai.panel.workOrderHint')}</span>
      </label>

      <div aria-label={t('ai.panel.threadLabel')} className="ai-thread" role="log">
        {conversation === null ? (
          <Empty description={t('ai.panel.emptyNoConversation')} />
        ) : turns.length === 0 ? (
          <Empty description={t('ai.panel.emptyNoTurn')} />
        ) : (
          turns.map((turn) => (
            <TurnBlock
              key={turn.questionUuid}
              onRetryTurn={onRetryTurn}
              retryingQuestionUuid={retryingQuestionUuid}
              turn={turn}
            />
          ))
        )}
      </div>

      {errorMessage !== null ? (
        <Alert
          action={
            activeQuestionUuid !== null ? (
              <Button onClick={onRefreshTurn} size="small">
                {t('ai.panel.refreshTurn')}
              </Button>
            ) : null
          }
          closable
          message={errorMessage}
          showIcon
          type="error"
        />
      ) : null}
      {noticeMessage !== null ? (
        <Alert closable message={noticeMessage} showIcon type="info" />
      ) : null}
      {generating ? (
        // V44：生成中在对话流内显示独立进度块（深色等宽），改由读屏播报
        <div aria-live="polite" className="ai-progress" role="status">
          {t('ai.panel.generating')}
        </div>
      ) : null}

      <div className="ai-compose">
        <Input.TextArea
          aria-label={t('ai.panel.inputLabel')}
          disabled={conversation === null}
          maxLength={2000}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              if (!busy && draft.trim().length > 0) {
                onSubmit();
              }
            }
          }}
          placeholder={t('ai.panel.inputPlaceholder')}
          rows={3}
          showCount
          value={draft}
        />
        <div className="ai-compose-actions flex items-center gap-2">
          <Button
            disabled={busy || draft.trim().length === 0}
            loading={submitting}
            onClick={onSubmit}
            type="primary"
          >
            {t('ai.panel.send')}
          </Button>
          {canRetry ? (
            <Button loading={retrying} onClick={onRetry}>
              {t('ai.panel.retry')}
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

type TurnBlockProps = {
  readonly turn: AiConversationTurn;
  readonly onRetryTurn: (questionUuid: string) => void;
  readonly retryingQuestionUuid: string | null;
};

function TurnBlock({ turn, onRetryTurn, retryingQuestionUuid }: TurnBlockProps) {
  const { t } = useI18n();
  const status = turn.analysisStatus;
  // F03：任一失败轮次都能单独重试，不依赖「当前关注轮」或「最后一轮」
  const canRetryThisTurn = status === 'FAILED' && turn.answer === null;
  return (
    <article className="flex flex-col gap-2">
      <div className="ai-message ai-message--mine">
        <span className="text-xs font-semibold text-text-secondary">{t('ai.panel.roleUser')}</span>
        <p className="m-0 whitespace-pre-wrap break-words text-sm">{turn.question?.text ?? ''}</p>
      </div>
      {turn.answer !== null ? (
        <div className="ai-message">
          <span className="text-xs font-semibold text-text-secondary">
            {t('ai.panel.roleAssistant')}
          </span>
          <p className="m-0 whitespace-pre-wrap break-words text-sm">{turn.answer.text}</p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
        <span>{t('ai.panel.turnLabel', { turn: turn.turnNo ?? '-' })}</span>
        {status !== null ? (
          <Tag color={STATUS_COLORS[status]}>{t(STATUS_LABEL_KEYS[status])}</Tag>
        ) : null}
        {turn.failureReason !== null ? (
          <span className="text-status-critical">{turn.failureReason}</span>
        ) : null}
        {canRetryThisTurn ? (
          <Button
            aria-label={t('ai.panel.retryTurnAria', { turn: turn.turnNo ?? '-' })}
            loading={retryingQuestionUuid === turn.questionUuid}
            onClick={() => onRetryTurn(turn.questionUuid)}
            size="small"
          >
            {t('ai.panel.retry')}
          </Button>
        ) : null}
      </div>
    </article>
  );
}
