// src/features/ai-conversation/application/use-ai-diagnosis-workspace.ts
// 工程师 AI 诊断工作区状态机（任务 05 · S3）
//
// 关键约束（来自任务书 V2.3 验收条款与 02 号页面逻辑文档）：
// - 受理与「生成中」必须以服务端事实为准：问题与待分析记录同事务保存后才显示生成中；
// - 提交结果未知时先查原问题（用同一问题 UUID 查询），不另造 UUID、不重复提问；
// - 重试沿用同一问题 UUID，不新增用户消息；
// - 迟到响应不得覆盖新画面：切换会话/工单/账号后，旧请求的响应一律丢弃；
// - 无有效图形时清除旧定位（回到流程参考图），正文照常保留；
// - 图形只在内存渲染，不写浏览器持久存储。

import { useCallback, useEffect, useRef, useState } from 'react';

import { base64ToBlob, saveBlobAsFile } from '@/shared/download';

import { parseAiVisualization } from '../domain/ai-visualization';
import type {
  AiConversationDetail,
  AiConversationListItem,
  AiQuestionStatus,
  AiVisualization,
} from '../infrastructure/ai-conversation.types';
import {
  createAiConversation,
  exportAiConversation,
  getAiQuestionStatus,
  getMyAiConversation,
  listMyAiConversations,
  retryAiQuestion,
  submitAiQuestion,
} from '../infrastructure/ai-conversation-adapter';

import { describeAiConversationError } from './ai-conversation-error';

const PAGE_SIZE = 20;
const POLL_INTERVAL_MS = 1500;
const QUESTION_MAX_LENGTH = 2000;

/** 终态：不再轮询 */
function isTerminalStatus(status: AiQuestionStatus['status']): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED';
}

export type AiDiagnosisWorkspaceState = {
  conversations: AiConversationListItem[];
  /** 服务端会话总数（F08：首页为空与真的没有记录必须可区分） */
  conversationsTotal: number;
  /** 已加载到第几页 */
  conversationsPage: number;
  /** 正在加载更多 */
  loadingMore: boolean;
  conversation: AiConversationDetail | null;
  selectedId: number | null;
  /** 手动选择的维修阶段（1–10；随问题快照提交） */
  stage: number | null;
  /** 当前轮有效图形（仅内存） */
  visualization: AiVisualization | null;
  /** 本轮图形是否降级（无图或非法） */
  visualizationDegraded: boolean;
  /** 当前轮问题 UUID（用于状态查询与重试） */
  activeQuestionUuid: string | null;
  /** 输入框内容（提交失败保留） */
  draft: string;
  loading: boolean;
  submitting: boolean;
  retrying: boolean;
  /** 正在导出当前会话（PDF） */
  exporting: boolean;
  /** 正在等待服务端回复 */
  generating: boolean;
  errorMessage: string | null;
  noticeMessage: string | null;
};

const INITIAL_STATE: AiDiagnosisWorkspaceState = {
  conversations: [],
  conversationsTotal: 0,
  conversationsPage: 0,
  loadingMore: false,
  conversation: null,
  selectedId: null,
  stage: null,
  visualization: null,
  visualizationDegraded: false,
  activeQuestionUuid: null,
  draft: '',
  loading: false,
  submitting: false,
  retrying: false,
  exporting: false,
  generating: false,
  errorMessage: null,
  noticeMessage: null,
};

/**
 * 工作区 hook：会话列表、会话详情、提问、轮询本轮状态、失败重试、图形应用。
 */
export function useAiDiagnosisWorkspace() {
  const [state, setState] = useState<AiDiagnosisWorkspaceState>(INITIAL_STATE);

  /** 会话代数：切换会话/新建时自增，用于丢弃旧会话的迟到响应 */
  const conversationEpoch = useRef(0);
  /** 轮次代数：同会话内切换关注轮次时自增，用于丢弃旧轮的迟到响应 */
  const turnEpoch = useRef(0);
  /** 同文本重试沿用同一 UUID：受理结果不明时再次提交不重复提问 */
  const pendingQuestion = useRef<{ text: string; uuid: string } | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** F06：创建/提交的同步防重入（按钮禁用不足以拦截连点与回车连发） */
  const creatingRef = useRef(false);
  const submittingRef = useRef(false);

  const clearPollTimer = useCallback(() => {
    if (pollTimer.current !== null) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  /** 切换会话/新建：清空上一轮的本地状态（图形、输入、提示），不跨会话复用结果 */
  const resetSessionState = useCallback(() => {
    conversationEpoch.current += 1;
    turnEpoch.current += 1;
    pendingQuestion.current = null;
    clearPollTimer();
    setState((current) => ({
      ...current,
      conversation: null,
      stage: null,
      visualization: null,
      visualizationDegraded: false,
      activeQuestionUuid: null,
      draft: '',
      generating: false,
      submitting: false,
      retrying: false,
      errorMessage: null,
      noticeMessage: null,
    }));
  }, [clearPollTimer]);

  const loadConversations = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, errorMessage: null }));
    try {
      const page = await listMyAiConversations({ page: 1, pageSize: PAGE_SIZE });
      setState((current) => ({
        ...current,
        conversations: page.items,
        conversationsTotal: page.total ?? page.items.length,
        conversationsPage: 1,
        loading: false,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        errorMessage: describeAiConversationError(error),
      }));
    }
  }, []);

  /** F08：加载下一页并追加（首页为空但 total>0 时可继续取） */
  const loadMoreConversations = useCallback(async () => {
    if (state.loadingMore || state.loading) {
      return;
    }
    const nextPage = state.conversationsPage + 1;
    setState((current) => ({ ...current, loadingMore: true, errorMessage: null }));
    try {
      const page = await listMyAiConversations({ page: nextPage, pageSize: PAGE_SIZE });
      setState((current) => {
        const seen = new Set(current.conversations.map((item) => item.id));
        return {
          ...current,
          conversations: [
            ...current.conversations,
            ...page.items.filter((item) => !seen.has(item.id)),
          ],
          conversationsTotal: page.total ?? current.conversationsTotal,
          conversationsPage: nextPage,
          loadingMore: false,
        };
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        loadingMore: false,
        errorMessage: describeAiConversationError(error),
      }));
    }
  }, [state.conversationsPage, state.loading, state.loadingMore]);

  const applyVisualization = useCallback(
    (status: AiQuestionStatus) => {
      const parsed = parseAiVisualization(status.visualization);
      setState((current) => ({
        ...current,
        // 无有效图形 → 清除旧定位（回到流程参考图），正文照常
        visualization: parsed.visualization,
        visualizationDegraded: parsed.degraded,
      }));
    },
    [],
  );

  /** 轮询本轮状态：迟到响应（会话/轮次已切换）直接丢弃 */
  const pollQuestionStatus = useCallback(
    async (conversationId: number, questionUuid: string) => {
      const sessionToken = conversationEpoch.current;
      const turnToken = turnEpoch.current;
      try {
        const status = await getAiQuestionStatus({ conversationId, questionUuid });
        if (
          sessionToken !== conversationEpoch.current ||
          turnToken !== turnEpoch.current
        ) {
          return;
        }
        if (isTerminalStatus(status.status)) {
          clearPollTimer();
          setState((current) => ({ ...current, generating: false }));
          applyVisualization(status);
          const detail = await getMyAiConversation(conversationId);
          if (
            sessionToken !== conversationEpoch.current ||
            turnToken !== turnEpoch.current
          ) {
            return;
          }
          setState((current) => ({ ...current, conversation: detail }));
          return;
        }
        setState((current) => ({ ...current, generating: true }));
        pollTimer.current = setTimeout(() => {
          void pollQuestionStatus(conversationId, questionUuid);
        }, POLL_INTERVAL_MS);
      } catch (error) {
        if (
          sessionToken !== conversationEpoch.current ||
          turnToken !== turnEpoch.current
        ) {
          return;
        }
        clearPollTimer();
        setState((current) => ({
          ...current,
          generating: false,
          errorMessage: describeAiConversationError(error),
        }));
      }
    },
    [applyVisualization, clearPollTimer],
  );

  const selectConversation = useCallback(
    async (conversationId: number) => {
      const sessionToken = conversationEpoch.current + 1;
      conversationEpoch.current = sessionToken;
      turnEpoch.current += 1;
      pendingQuestion.current = null;
      clearPollTimer();
      setState((current) => ({
        ...current,
        selectedId: conversationId,
        conversation: null,
        stage: null,
        visualization: null,
        visualizationDegraded: false,
        activeQuestionUuid: null,
        draft: '',
        generating: false,
        errorMessage: null,
        noticeMessage: null,
        loading: true,
      }));
      try {
        const detail = await getMyAiConversation(conversationId);
        if (conversationEpoch.current !== sessionToken) {
          return;
        }
        setState((current) => ({ ...current, conversation: detail, loading: false }));

        // F03：刷新/切换后恢复最后一轮的活跃问题与生成状态（不能只恢复列表与工具条）。
        // 以服务端状态为准：终态拉一次图形，未终态继续轮询直到结束。
        const latestTurn = [...detail.turns].sort((left, right) => (left.turnNo ?? 0) - (right.turnNo ?? 0)).at(-1);
        if (latestTurn !== undefined && conversationEpoch.current === sessionToken) {
          const stillRunning =
            latestTurn.analysisStatus === 'PENDING' || latestTurn.analysisStatus === 'RUNNING';
          setState((current) => ({
            ...current,
            activeQuestionUuid: latestTurn.questionUuid,
            generating: stillRunning,
          }));
          if (stillRunning) {
            // 未终态：继续按服务端事实推进，直到结束
            void pollQuestionStatus(detail.id, latestTurn.questionUuid);
          } else {
            // 已终态：只补一次本轮图形（图形不进库），不启动背景轮询
            void getAiQuestionStatus({
              conversationId: detail.id,
              questionUuid: latestTurn.questionUuid,
            })
              .then((status) => {
                if (conversationEpoch.current === sessionToken) {
                  applyVisualization(status);
                }
              })
              .catch(() => undefined);
          }
        }
      } catch (error) {
        if (conversationEpoch.current !== sessionToken) {
          return;
        }
        setState((current) => ({
          ...current,
          loading: false,
          errorMessage: describeAiConversationError(error),
        }));
      }
    },
    [applyVisualization, clearPollTimer, pollQuestionStatus],
  );

  const createConversation = useCallback(
    async (requestId: number | null) => {
      // F06-01：创建请求在飞时忽略后续触发，避免并发创建多个会话
      if (creatingRef.current) {
        return null;
      }
      creatingRef.current = true;
      resetSessionState();
      setState((current) => ({ ...current, loading: true, errorMessage: null }));
      try {
        const created = await createAiConversation(requestId);
        const page = await listMyAiConversations({ page: 1, pageSize: PAGE_SIZE });
        setState((current) => ({ ...current, conversations: page.items }));
        await selectConversation(created.id);
        return created;
      } catch (error) {
        setState((current) => ({
          ...current,
          loading: false,
          errorMessage: describeAiConversationError(error),
        }));
        return null;
      } finally {
        creatingRef.current = false;
      }
    },
    [resetSessionState, selectConversation],
  );

  /** 受理结果不明时先查原问题：查到即视为已受理（不重复提问） */
  const confirmAcceptedQuestion = useCallback(
    async (conversationId: number, questionUuid: string) => {
      try {
        const status = await getAiQuestionStatus({ conversationId, questionUuid });
        return status;
      } catch {
        return null;
      }
    },
    [],
  );

  const submitQuestion = useCallback(
    async (question: string) => {
      // F06-01：同一时刻只允许一个提交在飞（回车连发 / 连点）
      if (submittingRef.current) {
        return null;
      }
      const conversationId = state.selectedId;
      if (conversationId === null) {
        setState((current) => ({ ...current, errorMessage: '请先选择或新建一个会话' }));
        return null;
      }
      const trimmed = question.trim();
      if (trimmed.length === 0) {
        setState((current) => ({ ...current, errorMessage: '问题正文不能为空' }));
        return null;
      }
      if (trimmed.length > QUESTION_MAX_LENGTH) {
        setState((current) => ({
          ...current,
          errorMessage: `问题正文长度必须在 1–${QUESTION_MAX_LENGTH} 字之间`,
        }));
        return null;
      }

      // 同一文本重试沿用同一 UUID：网络失败再次提交不会产生第二条用户问题
      const pending =
        pendingQuestion.current && pendingQuestion.current.text === trimmed
          ? pendingQuestion.current
          : { text: trimmed, uuid: crypto.randomUUID() };
      pendingQuestion.current = pending;

      const sessionToken = conversationEpoch.current;
      const turnToken = turnEpoch.current + 1;
      turnEpoch.current = turnToken;

      submittingRef.current = true;
      setState((current) => ({
        ...current,
        submitting: true,
        errorMessage: null,
        noticeMessage: null,
        // F10：新一轮开始即清除上一轮图形定位，不等首次轮询返回
        visualization: null,
        visualizationDegraded: false,
      }));

      try {
        const result = await submitAiQuestion({
          conversationId,
          questionUuid: pending.uuid,
          question: trimmed,
          stage: state.stage,
        });
        if (sessionToken !== conversationEpoch.current || turnToken !== turnEpoch.current) {
          return null;
        }
        pendingQuestion.current = null;
        setState((current) => ({
          ...current,
          submitting: false,
          draft: '',
          activeQuestionUuid: result.questionUuid,
          generating: result.status === 'PENDING' || result.status === 'RUNNING',
          errorMessage:
            result.dispatchStatus === 'FAILED'
              ? '本轮派发失败，可重试本轮。'
              : null,
        }));
        const detail = await getMyAiConversation(conversationId);
        if (sessionToken !== conversationEpoch.current || turnToken !== turnEpoch.current) {
          return null;
        }
        setState((current) => ({ ...current, conversation: detail }));
        void pollQuestionStatus(conversationId, result.questionUuid);
        return result;
      } catch (error) {
        if (sessionToken !== conversationEpoch.current || turnToken !== turnEpoch.current) {
          return null;
        }
        // 受理结果不明：先查原问题；查到即按已受理处理
        const confirmed = await confirmAcceptedQuestion(conversationId, pending.uuid);
        if (
          confirmed !== null &&
          sessionToken === conversationEpoch.current &&
          turnToken === turnEpoch.current
        ) {
          pendingQuestion.current = null;
          setState((current) => ({
            ...current,
            submitting: false,
            draft: '',
            activeQuestionUuid: confirmed.questionUuid,
            generating: !isTerminalStatus(confirmed.status),
            noticeMessage: '提交结果不明，已按原问题核对，服务端已受理。',
          }));
          const detail = await getMyAiConversation(conversationId);
          if (
            sessionToken === conversationEpoch.current &&
            turnToken === turnEpoch.current
          ) {
            setState((current) => ({ ...current, conversation: detail }));
          }
          void pollQuestionStatus(conversationId, confirmed.questionUuid);
          return null;
        }
        // 未受理：保留输入与错误，用户可原样重试（沿用同一 UUID）
        setState((current) => ({
          ...current,
          submitting: false,
          draft: trimmed,
          errorMessage: describeAiConversationError(error),
        }));
        return null;
      } finally {
        submittingRef.current = false;
      }
    },
    [confirmAcceptedQuestion, pollQuestionStatus, state.selectedId, state.stage],
  );

  /** 重试失败轮次：沿用同一问题 UUID，不新增用户消息 */
  const retryCurrentTurn = useCallback(async () => {
    const conversationId = state.selectedId;
    const questionUuid = state.activeQuestionUuid;
    if (conversationId === null || questionUuid === null) {
      setState((current) => ({ ...current, errorMessage: '没有可重试的轮次' }));
      return null;
    }
    const sessionToken = conversationEpoch.current;
    const turnToken = turnEpoch.current + 1;
    turnEpoch.current = turnToken;
    setState((current) => ({
      ...current,
      retrying: true,
      errorMessage: null,
      noticeMessage: null,
      // F10：重试同样从干净图形状态开始
      visualization: null,
      visualizationDegraded: false,
    }));
    try {
      const result = await retryAiQuestion({
        conversationId,
        questionUuid,
        stage: state.stage,
      });
      if (sessionToken !== conversationEpoch.current || turnToken !== turnEpoch.current) {
        return null;
      }
      setState((current) => ({
        ...current,
        retrying: false,
        generating: result.status === 'PENDING' || result.status === 'RUNNING',
        errorMessage:
          result.dispatchStatus === 'FAILED' ? '本轮派发失败，可重试本轮。' : null,
      }));
      const detail = await getMyAiConversation(conversationId);
      if (sessionToken !== conversationEpoch.current || turnToken !== turnEpoch.current) {
        return null;
      }
      setState((current) => ({ ...current, conversation: detail }));
      void pollQuestionStatus(conversationId, questionUuid);
      return result;
    } catch (error) {
      if (sessionToken !== conversationEpoch.current || turnToken !== turnEpoch.current) {
        return null;
      }
      setState((current) => ({
        ...current,
        retrying: false,
        errorMessage: describeAiConversationError(error),
      }));
      return null;
    }
  }, [pollQuestionStatus, state.activeQuestionUuid, state.selectedId, state.stage]);

  /**
   * 导出当前会话为 PDF（任务 05 · S4.2 · R039-01）。
   *
   * 固定当前内容版本：导出期间服务端新增的消息不混入本次产物；
   * 服务端失败或产物为空时抛错，不落地空文件。
   */
  const exportConversationPdf = useCallback(async () => {
    const current = state.conversation;
    if (current === null) {
      return;
    }
    setState((previous) => ({ ...previous, exporting: true, errorMessage: null }));
    try {
      const payload = await exportAiConversation({
        conversationId: current.id,
        contentVersion: current.contentVersion,
        format: 'PDF',
      });
      const blob = base64ToBlob(payload.contentBase64, payload.mimeType);
      if (blob.size === 0) {
        throw new Error('导出产物为空，请稍后重试');
      }
      saveBlobAsFile(blob, payload.filename);
      setState((previous) => ({
        ...previous,
        exporting: false,
        noticeMessage: `已导出 ${payload.filename}（版本 v${payload.contentVersion}）`,
      }));
    } catch (error) {
      setState((previous) => ({
        ...previous,
        exporting: false,
        errorMessage: describeAiConversationError(error),
      }));
    }
  }, [state.conversation]);

  const setStage = useCallback((stage: number | null) => {
    setState((current) => ({ ...current, stage }));
  }, []);

  const setDraft = useCallback((draft: string) => {
    setState((current) => ({ ...current, draft }));
  }, []);

  const dismissNotice = useCallback(() => {
    setState((current) => ({ ...current, noticeMessage: null }));
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  // 组件卸载/账号切换：停止轮询并丢弃在途响应
  useEffect(
    () => () => {
      conversationEpoch.current += 1;
      turnEpoch.current += 1;
      if (pollTimer.current !== null) {
        clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
    },
    [],
  );

  return {
    ...state,
    loadConversations,
    loadMoreConversations,
    selectConversation,
    createConversation,
    submitQuestion,
    retryCurrentTurn,
    exportConversationPdf,
    setStage,
    setDraft,
    dismissNotice,
  };
}
