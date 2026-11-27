// src/features/reference-document/application/use-reference-document-list.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import type {
  ReferenceDocumentListFilter,
  ReferenceDocumentListItem,
} from '../infrastructure/reference-document.types';
import { fetchReferenceDocuments } from '../infrastructure/reference-document-adapter';

/**
 * 历史维修记录列表流程（query 状态机，收束在 feature application）。
 *
 * - filter 直接对齐后端 ReferenceDocumentFilterInput 的可选语义，不创建第三套状态值；
 * - 加载中 / 空结果 / 失败（含重试）/ 分页齐全；
 * - 请求序号随状态原子更新：切换筛选、翻页或重试后，旧请求返回不会覆盖当前结果；
 * - filter 变化回到第 1 页；auth 错误不在这里特殊处理，
 *   仍由共享 GraphQL + auth-session 全局链路负责。
 */

export type ReferenceDocumentListState =
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

type ReferenceDocumentListAction =
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
  return isGraphQLIngressError(error)
    ? error.userMessage
    : '历史维修记录列表加载失败，请稍后重试。';
}

function referenceDocumentListReducer(
  state: ReferenceDocumentListState,
  action: ReferenceDocumentListAction,
): ReferenceDocumentListState {
  switch (action.type) {
    case 'load-start':
      // 开始新请求：原子切换到 loading 并记录序号，旧结果不再可能被应用
      return { status: 'loading', requestSeq: action.requestId };
    case 'load-ready':
      // 竞态防护：过期请求的结果直接丢弃
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

/** filter 等价判断：避免父组件内联对象引用变化触发多余重载 */
function isSameFilter(
  a: ReferenceDocumentListFilter | undefined,
  b: ReferenceDocumentListFilter | undefined,
): boolean {
  const aKeyword = a?.titleKeyword ?? '';
  const bKeyword = b?.titleKeyword ?? '';
  const aType = a?.documentType ?? '';
  const bType = b?.documentType ?? '';
  const aModel = a?.equipmentModelId;
  const bModel = b?.equipmentModelId;

  return aKeyword === bKeyword && aType === bType && aModel === bModel;
}

export function useReferenceDocumentList(
  filter: ReferenceDocumentListFilter | undefined,
  pageSize = 10,
) {
  const [state, dispatch] = useReducer(referenceDocumentListReducer, {
    status: 'loading',
    requestSeq: 0,
  });
  const requestIdRef = useRef(0);
  const cursorRef = useRef({ filter, page: 1, pageSize });

  const loadList = useCallback(
    async (targetFilter: ReferenceDocumentListFilter | undefined, page: number) => {
      requestIdRef.current += 1;
      const requestId = requestIdRef.current;

      cursorRef.current = { filter: targetFilter, page, pageSize };
      dispatch({ type: 'load-start', requestId });

      try {
        const result = await fetchReferenceDocuments({ page, pageSize }, targetFilter);
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

  // 初次加载；filter 变化（引用按值比较）时回到第 1 页重载
  const appliedFilterRef = useRef(filter);
  useEffect(() => {
    if (!isSameFilter(appliedFilterRef.current, filter)) {
      appliedFilterRef.current = filter;
      void loadList(filter, 1);

      return;
    }

    if (state.status === 'loading' && state.requestSeq === 0) {
      void loadList(filter, 1);
    }
  }, [filter, loadList, state.status, state.requestSeq]);

  const goToPage = useCallback(
    (page: number) => {
      void loadList(cursorRef.current.filter, page);
    },
    [loadList],
  );

  const reload = useCallback(() => {
    const cursor = cursorRef.current;

    void loadList(cursor.filter, cursor.page);
  }, [loadList]);

  return { state, goToPage, reload };
}
