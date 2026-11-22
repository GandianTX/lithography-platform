// src/features/reference-document/application/use-pending-ownership-list.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import type { ReferenceDocumentListItem } from '../infrastructure/reference-document.types';
import { fetchPendingOwnershipReferenceDocuments } from '../infrastructure/reference-document-adapter';

/**
 * 归属待核实清单流程（任务 07 R061-01，query 状态机，收束在 feature application）。
 *
 * - 与普通资料库列表分开的独立状态机：无筛选维度（R061-01 输入仅分页）；
 * - 加载中 / 空结果 / 失败（含重试）/ 分页齐全；
 * - 请求序号随状态原子更新：翻页或重试后旧请求返回不会覆盖当前结果；
 * - auth 错误由共享 GraphQL + auth-session 全局链路负责；
 * - 二级管理员 / 工程师 / 客户直调由服务端拒绝，这里按失败态展示，不伪造数据。
 */

export type PendingOwnershipListState =
  | { status: 'loading'; requestSeq: number }
  | {
      status: 'ready';
      requestSeq: number;
      items: ReferenceDocumentListItem[];
      total: number;
      page: number;
      pageSize: number;
    }
  | { status: 'failed'; requestSeq: number; message: string };

type PendingOwnershipListAction =
  | { type: 'load-start'; requestId: number }
  | {
      type: 'load-ready';
      requestId: number;
      items: ReferenceDocumentListItem[];
      total: number;
      page: number;
      pageSize: number;
    }
  | { type: 'load-failed'; requestId: number; message: string };

function toListUserMessage(error: unknown): string {
  return isGraphQLIngressError(error) ? error.userMessage : '归属待核实清单加载失败，请稍后重试。';
}

function pendingOwnershipListReducer(
  state: PendingOwnershipListState,
  action: PendingOwnershipListAction,
): PendingOwnershipListState {
  switch (action.type) {
    case 'load-start':
      return { status: 'loading', requestSeq: action.requestId };
    case 'load-ready':
      if (action.requestId !== state.requestSeq) {
        return state;
      }

      return {
        status: 'ready',
        requestSeq: action.requestId,
        items: action.items,
        total: action.total,
        page: action.page,
        pageSize: action.pageSize,
      };
    case 'load-failed':
      if (action.requestId !== state.requestSeq) {
        return state;
      }

      return { status: 'failed', requestSeq: action.requestId, message: action.message };
  }
}

export function usePendingOwnershipList(pageSize = 10) {
  const [state, dispatch] = useReducer(pendingOwnershipListReducer, {
    status: 'loading',
    requestSeq: 0,
  });
  const requestIdRef = useRef(0);
  const pageCursorRef = useRef(1);

  const loadList = useCallback(
    async (page: number) => {
      requestIdRef.current += 1;
      const requestId = requestIdRef.current;

      pageCursorRef.current = page;
      dispatch({ type: 'load-start', requestId });

      try {
        const result = await fetchPendingOwnershipReferenceDocuments({ page, pageSize });
        dispatch({
          type: 'load-ready',
          requestId,
          items: result.items,
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
        });
      } catch (error) {
        dispatch({ type: 'load-failed', requestId, message: toListUserMessage(error) });
      }
    },
    [pageSize],
  );

  // 初次加载
  useEffect(() => {
    if (state.status === 'loading' && state.requestSeq === 0) {
      void loadList(1);
    }
  }, [loadList, state.status, state.requestSeq]);

  const goToPage = useCallback(
    (page: number) => {
      void loadList(page);
    },
    [loadList],
  );

  const reload = useCallback(() => {
    void loadList(pageCursorRef.current);
  }, [loadList]);

  return { state, goToPage, reload };
}
