// src/features/ai-conversation/application/use-ai-conversation-console.ts

import { useCallback, useEffect, useRef, useState } from 'react';

import { isGraphQLIngressError, readGraphQLErrorDetail } from '@/shared/graphql';

import type {
  AiConversationDetail,
  AiConversationListItem,
  AiQuestionStatus,
} from '../infrastructure/ai-conversation.types';
import {
  createAiConversation,
  getAiQuestionStatus,
  getMyAiConversation,
  listMyAiConversations,
  submitAiQuestion,
} from '../infrastructure/ai-conversation-adapter';

const PAGE_SIZE = 20;

export type AiConversationConsoleState = {
  conversations: AiConversationListItem[];
  detail: AiConversationDetail | null;
  selectedId: number | null;
  lastStatus: AiQuestionStatus | null;
  loading: boolean;
  submitting: boolean;
  errorMessage: string | null;
};

/**
 * 工程师 AI 对话最小控制台（任务 05 · S1 可操作页面的唯一状态源）
 *
 * 关键约束：
 * - 问题稳定 UUID 由前端生成并在「同一文本重试」时复用，成功后释放，
 *   保证网络失败重试不会产生第二条用户问题；
 * - 只展示服务端返回的分析状态，不本地推断生成结果；
 * - 切换会话即清空上一轮的本地状态，不跨会话复用结果。
 */
export function useAiConversationConsole() {
  const [state, setState] = useState<AiConversationConsoleState>({
    conversations: [],
    detail: null,
    selectedId: null,
    lastStatus: null,
    loading: false,
    submitting: false,
    errorMessage: null,
  });
  const pendingQuestion = useRef<{ text: string; uuid: string } | null>(null);

  const describeError = (error: unknown): string => {
    const detail = readGraphQLErrorDetail(error);
    if (detail?.errorMessage) {
      return detail.errorMessage;
    }
    if (detail?.errorCode) {
      return detail.errorCode;
    }
    if (isGraphQLIngressError(error)) {
      return error.message;
    }
    return error instanceof Error ? error.message : '请求失败，请稍后重试';
  };

  const loadConversations = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, errorMessage: null }));
    try {
      const page = await listMyAiConversations({ page: 1, pageSize: PAGE_SIZE });
      setState((current) => ({ ...current, conversations: page.items, loading: false }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        errorMessage: describeError(error),
      }));
    }
  }, []);

  const selectConversation = useCallback(async (conversationId: number) => {
    setState((current) => ({
      ...current,
      selectedId: conversationId,
      loading: true,
      detail: null,
      lastStatus: null,
      errorMessage: null,
    }));
    try {
      const detail = await getMyAiConversation(conversationId);
      setState((current) => ({ ...current, detail, loading: false }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        errorMessage: describeError(error),
      }));
    }
  }, []);

  const createConversation = useCallback(
    async (requestId: number | null) => {
      setState((current) => ({ ...current, loading: true, errorMessage: null }));
      try {
        const created = await createAiConversation(requestId);
        const page = await listMyAiConversations({ page: 1, pageSize: PAGE_SIZE });
        setState((current) => ({
          ...current,
          conversations: page.items,
          selectedId: created.id,
          loading: false,
        }));
        await selectConversation(created.id);
        return created;
      } catch (error) {
        setState((current) => ({
          ...current,
          loading: false,
          errorMessage: describeError(error),
        }));
        return null;
      }
    },
    [selectConversation],
  );

  const submitQuestion = useCallback(
    async (question: string) => {
      const conversationId = state.selectedId;
      if (conversationId === null) {
        setState((current) => ({ ...current, errorMessage: '请先选择或新建一个会话' }));
        return;
      }
      const trimmed = question.trim();
      if (trimmed.length === 0) {
        setState((current) => ({ ...current, errorMessage: '问题正文不能为空' }));
        return;
      }

      // 同一文本重试沿用同一 UUID：保证「重试不重复新增用户问题」
      const pending =
        pendingQuestion.current && pendingQuestion.current.text === trimmed
          ? pendingQuestion.current
          : { text: trimmed, uuid: crypto.randomUUID() };
      pendingQuestion.current = pending;

      setState((current) => ({ ...current, submitting: true, errorMessage: null }));
      try {
        const result = await submitAiQuestion({
          conversationId,
          questionUuid: pending.uuid,
          question: trimmed,
        });
        pendingQuestion.current = null;
        const [detail, status] = await Promise.all([
          getMyAiConversation(conversationId),
          getAiQuestionStatus({ conversationId, questionUuid: result.questionUuid }),
        ]);
        setState((current) => ({
          ...current,
          submitting: false,
          detail,
          lastStatus: status,
        }));
        await loadConversations();
      } catch (error) {
        // 保留 pendingQuestion：用户再次提交同一文本时复用同一 UUID
        setState((current) => ({
          ...current,
          submitting: false,
          errorMessage: describeError(error),
        }));
      }
    },
    [loadConversations, state.selectedId],
  );

  const refreshQuestionStatus = useCallback(
    async (questionUuid: string) => {
      if (state.selectedId === null) {
        return null;
      }
      try {
        const status = await getAiQuestionStatus({
          conversationId: state.selectedId,
          questionUuid,
        });
        setState((current) => ({ ...current, lastStatus: status }));
        return status;
      } catch (error) {
        setState((current) => ({ ...current, errorMessage: describeError(error) }));
        return null;
      }
    },
    [state.selectedId],
  );

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  return {
    ...state,
    loadConversations,
    selectConversation,
    createConversation,
    submitQuestion,
    refreshQuestionStatus,
  };
}
