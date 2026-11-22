// src/features/sync-conflict/application/use-sync-conflict-list.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import type { SyncConflictSummary } from '../infrastructure/sync-conflict.types';
import { fetchSyncConflicts } from '../infrastructure/sync-conflict-adapter';

type SyncConflictListState =
  | { status: 'loading'; requestSeq: number }
  | {
      status: 'ready';
      requestSeq: number;
      items: SyncConflictSummary[];
      total: number | null;
      page: number;
      pageSize: number;
      truncated: boolean | null;
    }
  | { status: 'failed'; requestSeq: number; message: string };

type SyncConflictListAction =
  | { type: 'load-start'; requestSeq: number }
  | {
      type: 'load-ready';
      requestSeq: number;
      items: SyncConflictSummary[];
      total: number | null;
      page: number;
      pageSize: number;
      truncated: boolean | null;
    }
  | { type: 'load-failed'; requestSeq: number; message: string };

function toUserMessage(error: unknown): string {
  return isGraphQLIngressError(error) ? error.userMessage : '同步冲突加载失败，请稍后重试。';
}

function syncConflictListReducer(
  state: SyncConflictListState,
  action: SyncConflictListAction,
): SyncConflictListState {
  switch (action.type) {
    case 'load-start':
      return { status: 'loading', requestSeq: action.requestSeq };
    case 'load-ready':
      // 请求序号原子更新：旧请求结果不覆盖新结果
      if (action.requestSeq !== state.requestSeq) {
        return state;
      }
      return { status: 'ready', ...action };
    case 'load-failed':
      if (action.requestSeq !== state.requestSeq) {
        return state;
      }
      return { status: 'failed', ...action };
  }
}

/**
 * 冲突清单流程（query 状态机，收束在 feature application）。
 *
 * - 只看未处理：默认只列 PENDING，切换时回到第 1 页；
 * - 分页与重试沿用当前视图口径；
 * - 服务端计算 total 与 truncated，前端不二次推断。
 */
export function useSyncConflictList(statusOnlyPending: boolean, pageSize = 10) {
  const [state, dispatch] = useReducer(syncConflictListReducer, {
    status: 'loading',
    requestSeq: 0,
  } as SyncConflictListState);
  const requestSeqRef = useRef(0);
  const cursorRef = useRef({ statusOnlyPending, page: 1, pageSize });

  const loadList = useCallback(
    async (nextStatusOnlyPending: boolean, page: number) => {
      requestSeqRef.current += 1;
      const requestSeq = requestSeqRef.current;
      cursorRef.current = { statusOnlyPending: nextStatusOnlyPending, page, pageSize };

      dispatch({ type: 'load-start', requestSeq });

      try {
        const result = await fetchSyncConflicts({
          statusOnlyPending: nextStatusOnlyPending,
          page,
          pageSize,
        });
        dispatch({
          type: 'load-ready',
          requestSeq,
          items: result.items,
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          truncated: result.truncated,
        });
      } catch (error) {
        dispatch({ type: 'load-failed', requestSeq, message: toUserMessage(error) });
      }
    },
    [pageSize],
  );

  useEffect(() => {
    void loadList(statusOnlyPending, 1);
  }, [loadList, statusOnlyPending]);

  const goToPage = useCallback(
    (page: number) => {
      void loadList(cursorRef.current.statusOnlyPending, page);
    },
    [loadList],
  );

  const reload = useCallback(() => {
    const cursor = cursorRef.current;
    void loadList(cursor.statusOnlyPending, cursor.page);
  }, [loadList]);

  return { state, goToPage, reload };
}
