// src/features/admin-document-database/application/use-admin-document-detail.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import type {
  AdminAiConversationDetail,
  AdminAiMessageListItem,
  AdminAiReportDetail,
  AdminListPage,
  AdminRepairRequestSummary,
} from '../infrastructure/admin-document-database.types';
import {
  type AdminDetailResult,
  fetchAdminAiConversationDetail,
  fetchAdminAiMessages,
  fetchAdminAiReportDetail,
  fetchAdminRepairRequestSummary,
} from '../infrastructure/admin-document-database-adapter';

/**
 * 详情读取状态机（维修申请摘要 / AI 报告正文 / AI 会话消息）。
 *
 * 详情是「按需打开」的一次性读取：打开时发起请求，业务拒绝显示在面板内
 * （不弹全局错误），transport 失败可重试。请求序号防连点与旧请求晚到覆盖。
 */

export type AdminDetailState<TDetail> =
  | { status: 'loading'; requestId: number }
  | { status: 'ready'; requestId: number; detail: TDetail }
  | { status: 'failed'; requestId: number; message: string };

type AdminDetailAction<TDetail> =
  | { type: 'load-start'; requestId: number }
  | { type: 'load-ready'; requestId: number; detail: TDetail }
  | { type: 'load-failed'; requestId: number; message: string };

function createAdminDetailReducer<TDetail>() {
  return function adminDetailReducer(
    state: AdminDetailState<TDetail>,
    action: AdminDetailAction<TDetail>,
  ): AdminDetailState<TDetail> {
    switch (action.type) {
      case 'load-start':
        return { status: 'loading', requestId: action.requestId };
      case 'load-ready':
        if (action.requestId !== state.requestId) {
          return state;
        }

        return { status: 'ready', requestId: action.requestId, detail: action.detail };
      case 'load-failed':
        if (action.requestId !== state.requestId) {
          return state;
        }

        return { status: 'failed', requestId: action.requestId, message: action.message };
    }
  };
}

function toDetailUserMessage(error: unknown, fallback: string): string {
  return isGraphQLIngressError(error) ? error.userMessage : fallback;
}

function useAdminDetail<TDetail>(
  fetcher: (
    requestId: number,
  ) => Promise<{ ok: true; detail: TDetail } | { ok: false; message: string }>,
  targetId: number | null,
  fallbackMessage: string,
) {
  const [state, dispatch] = useReducer(createAdminDetailReducer<TDetail>(), {
    status: 'loading',
    requestId: 0,
  });
  const requestIdRef = useRef(0);
  // fetcher 引用稳定化：消费方（useAdminRepairRequestSummary 等）每次渲染新建内联
  // fetcher，若 load 直接依赖 fetcher，则 effect 每渲染重新发请求，requestId 持续
  // 递增导致所有已完成的响应被竞态校验丢弃，详情面板永远停留在 loading 骨架
  // （Playwright 真实链路暴露的 S3 缺陷）。经 ref 收口后 load 引用稳定，
  // 仅 targetId 变化时重新读取；ref 同步置于渲染后、读目标 effect 之前的
  // 独立 effect 内（effect 按定义顺序执行，首次读取前 ref 必已就绪）。
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  const load = useCallback(
    async (target: number): Promise<boolean> => {
      requestIdRef.current += 1;
      const requestId = requestIdRef.current;

      dispatch({ type: 'load-start', requestId });

      try {
        const result = await fetcherRef.current(target);

        if (result.ok) {
          dispatch({ type: 'load-ready', requestId, detail: result.detail });
          return true;
        }
        dispatch({ type: 'load-failed', requestId, message: result.message });
        return false;
      } catch (error) {
        dispatch({
          type: 'load-failed',
          requestId,
          message: toDetailUserMessage(error, fallbackMessage),
        });
        return false;
      }
    },
    [fallbackMessage],
  );

  useEffect(() => {
    if (targetId === null) {
      return;
    }

    void load(targetId);
  }, [targetId, load]);

  const retry = useCallback(() => {
    if (targetId !== null) {
      void load(targetId);
    }
  }, [targetId, load]);

  /**
   * 主动刷新并返回是否成功。供「修订已提交后刷新详情」使用：
   * false 表示具名详情读取失败（面板自身已进入 failed 可重试状态），
   * 调用方据此区分「保存成功」与「保存成功但刷新失败」，不得反向提示保存失败。
   */
  const reload = useCallback(async (): Promise<boolean> => {
    if (targetId === null) {
      return false;
    }
    return load(targetId);
  }, [targetId, load]);

  return { state, retry, reload };
}

/** 维修申请只读详情（已提交事实） */
export function useAdminRepairRequestSummary(requestId: number | null) {
  return useAdminDetail<AdminRepairRequestSummary>(
    (target) => fetchAdminRepairRequestSummary(target),
    requestId,
    '维修申请详情加载失败，请稍后重试。',
  );
}

/** AI 报告只读正文 */
export function useAdminAiReportDetail(reportId: number | null) {
  return useAdminDetail<AdminAiReportDetail>(
    (target) => fetchAdminAiReportDetail(target),
    reportId,
    'AI 报告详情加载失败，请稍后重试。',
  );
}

/** AI 会话消息（Drawer 内分页；服务端按 messageSeq ASC + id ASC 稳定排序） */
export function useAdminAiConversationMessages(conversationId: number | null, page: number) {
  const [state, dispatch] = useReducer(
    createAdminDetailReducer<AdminListPage<AdminAiMessageListItem>>(),
    {
      status: 'loading',
      requestId: 0,
    },
  );
  const requestIdRef = useRef(0);

  const load = useCallback(async (target: number, targetPage: number) => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;

    dispatch({ type: 'load-start', requestId });

    try {
      const result: AdminDetailResult<AdminListPage<AdminAiMessageListItem>> = {
        ok: true,
        detail: await fetchAdminAiMessages(target, targetPage, 50),
      };
      dispatch({ type: 'load-ready', requestId, detail: result.detail });
    } catch (error) {
      dispatch({
        type: 'load-failed',
        requestId,
        message: toDetailUserMessage(error, '会话消息加载失败，请稍后重试。'),
      });
    }
  }, []);

  useEffect(() => {
    if (conversationId === null) {
      return;
    }

    void load(conversationId, page);
  }, [conversationId, page, load]);

  const retry = useCallback(() => {
    if (conversationId !== null) {
      void load(conversationId, page);
    }
  }, [conversationId, page, load]);

  return { state, retry };
}

/**
 * 管理员只读会话详情（任务 05 · S4.1 · R038-01）。
 *
 * 只读读取：不提供提问入口；会话范围（跨公司 / 本公司）由服务端裁决，
 * 直传外公司 ID 时按「无权访问」提示，不回显外公司内容。
 */
export function useAdminAiConversationDetail(conversationId: number | null) {
  const [state, dispatch] = useReducer(createAdminDetailReducer<AdminAiConversationDetail>(), {
    status: 'loading',
    requestId: 0,
  });
  const requestIdRef = useRef(0);

  const load = useCallback(async (target: number) => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;

    dispatch({ type: 'load-start', requestId });

    try {
      const detail = await fetchAdminAiConversationDetail(target);
      dispatch({ type: 'load-ready', requestId, detail });
    } catch (error) {
      dispatch({
        type: 'load-failed',
        requestId,
        message: toDetailUserMessage(error, '会话详情加载失败，请稍后重试。'),
      });
    }
  }, []);

  useEffect(() => {
    if (conversationId === null) {
      return;
    }

    void load(conversationId);
  }, [conversationId, load]);

  const retry = useCallback(() => {
    if (conversationId !== null) {
      void load(conversationId);
    }
  }, [conversationId, load]);

  return { state, retry };
}
