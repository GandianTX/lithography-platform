// src/features/admin-operation-records/application/use-operation-records-list.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

/**
 * 关键操作记录列表状态机（任务 10 S3.2）。
 *
 * 与 features/admin-document-database 的列表状态机同构但独立实现：
 * - `requestSeq` 原子竞态防护：**会话或可信公司变化（reloadKey 变化）触发回到第 1 页
 *   重载，旧响应一律丢弃**——这是「旧响应隔离」验收的结构性保证；
 * - 失败可重试（retry 重放当前页）；
 * - 本页无筛选/排序参数，状态机因此没有 filter 维度，保持最小形状。
 */

export type OperationRecordsState<TItem> =
  | { status: 'loading'; requestSeq: number }
  | {
      status: 'ready';
      requestSeq: number;
      items: TItem[];
      total: number;
      page: number;
      pageSize: number;
    }
  | { status: 'failed'; requestSeq: number; message: string };

type OperationRecordsAction<TItem> =
  | { type: 'load-start'; requestId: number }
  | {
      type: 'load-ready';
      requestId: number;
      items: TItem[];
      total: number;
      page: number;
      pageSize: number;
    }
  | { type: 'load-failed'; requestId: number; message: string };

function createOperationRecordsReducer<TItem>() {
  return function operationRecordsReducer(
    state: OperationRecordsState<TItem>,
    action: OperationRecordsAction<TItem>,
  ): OperationRecordsState<TItem> {
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
  };
}

type OperationRecordsFetcher<TItem> = (
  page: number,
  pageSize: number,
) => Promise<{
  items: TItem[];
  total: number;
  page: number;
  pageSize: number;
}>;

function toListUserMessage(error: unknown, fallback: string): string {
  return isGraphQLIngressError(error) ? error.userMessage : fallback;
}

/**
 * @param fetcher 每次渲染期稳定的取数函数（调用方用 useCallback 固定）
 * @param reloadKey 会话/公司身份键：变化时回到第 1 页重载并隔离旧响应
 */
export function useOperationRecordsList<TItem>(
  fetcher: OperationRecordsFetcher<TItem>,
  reloadKey: string,
  options?: {
    pageSize?: number;
    enabled?: boolean;
    failureMessage?: string;
  },
) {
  const pageSize = options?.pageSize ?? 10;
  const enabled = options?.enabled ?? true;
  const [state, dispatch] = useReducer(createOperationRecordsReducer<TItem>(), {
    status: 'loading',
    requestSeq: 0,
  });
  const requestIdRef = useRef(0);
  const cursorRef = useRef({ page: 1, pageSize });

  const loadPage = useCallback(
    async (page: number) => {
      requestIdRef.current += 1;
      const requestId = requestIdRef.current;

      cursorRef.current = { page, pageSize };
      dispatch({ type: 'load-start', requestId });

      try {
        const result = await fetcher(page, pageSize);
        dispatch({
          type: 'load-ready',
          requestId,
          items: result.items,
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
        });
      } catch (error) {
        dispatch({
          type: 'load-failed',
          requestId,
          message: toListUserMessage(
            error,
            options?.failureMessage ?? '关键操作记录加载失败，请稍后重试。',
          ),
        });
      }
    },
    [fetcher, pageSize, options?.failureMessage],
  );

  // 初次加载与 reloadKey 变化（会话/可信公司变更 → 回到第 1 页并隔离旧响应）
  const appliedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (
      appliedKeyRef.current !== reloadKey ||
      (state.status === 'loading' && state.requestSeq === 0)
    ) {
      appliedKeyRef.current = reloadKey;
      void loadPage(1);
    }
  }, [enabled, reloadKey, loadPage, state.status, state.requestSeq]);

  const goToPage = useCallback(
    (page: number) => {
      void loadPage(page);
    },
    [loadPage],
  );

  const reload = useCallback(() => {
    void loadPage(cursorRef.current.page);
  }, [loadPage]);

  return { state, goToPage, reload };
}
