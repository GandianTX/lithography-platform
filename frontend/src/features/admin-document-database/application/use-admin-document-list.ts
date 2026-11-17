// src/features/admin-document-database/application/use-admin-document-list.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

/**
 * 管理员文档数据库通用列表状态机（PR3 S3）。
 *
 * 与 features/reference-document 的列表 hook 同构：requestSeq 原子竞态防护、
 * filter 变化回到第 1 页、失败可重试。四个标签各自实例化本 hook，
 * 状态互不共享——这是「切换/翻页不串数据」验收的结构性保证。
 */

export type AdminListState<TItem> =
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

type AdminListAction<TItem> =
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

function createAdminListReducer<TItem>() {
  return function adminListReducer(
    state: AdminListState<TItem>,
    action: AdminListAction<TItem>,
  ): AdminListState<TItem> {
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

type AdminListFetcher<TItem> = (
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
 * @param fetcher 每次渲染期稳定的取数函数（调用方用 useMemo/useCallback 固定；
 *                内部闭包持有当次 filter，hook 不再感知 filter 形状）
 * @param reloadKey 重载键：filter/参数变化时递增触发回到第 1 页重载
 */
export function useAdminDocumentList<TItem>(
  fetcher: AdminListFetcher<TItem>,
  reloadKey: string,
  options?: {
    pageSize?: number;
    enabled?: boolean;
    failureMessage?: string;
    /** 首次加载页码（从详情返回时恢复分页）；筛选变化仍回到第 1 页 */
    initialPage?: number;
  },
) {
  const pageSize = options?.pageSize ?? 10;
  const enabled = options?.enabled ?? true;
  const initialPage = options?.initialPage ?? 1;
  const [state, dispatch] = useReducer(createAdminListReducer<TItem>(), {
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
            options?.failureMessage ?? '列表加载失败，请稍后重试。',
          ),
        });
      }
    },
    [fetcher, pageSize, options?.failureMessage],
  );

  // 初次加载与 reloadKey 变化（筛选/参数变更 → 回到第 1 页）
  const appliedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (
      appliedKeyRef.current !== reloadKey ||
      (state.status === 'loading' && state.requestSeq === 0)
    ) {
      const isFirstLoad = appliedKeyRef.current === null;
      appliedKeyRef.current = reloadKey;
      void loadPage(isFirstLoad ? initialPage : 1);
    }
  }, [enabled, reloadKey, loadPage, state.status, state.requestSeq, initialPage]);

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
