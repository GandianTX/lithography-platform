// src/features/admin-user-management/application/use-admin-bound-level-two-admins.ts

/**
 * 一级专用「已绑定二级管理员」候选查询（use case / query）。
 *
 * - 只在凭据重置弹窗打开且调用方允许（一级）时加载，关闭即回到 idle；
 * - 服务端分页与关键字检索，关键字防抖 300ms，变化回到第 1 页；
 * - 请求序号随状态原子更新：快速改关键字或翻页后，旧响应不会覆盖当前结果；
 * - 主列表 `adminUsers` 的过滤规则不受影响：候选来自独立的窄查询。
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import { fetchAdminBoundLevelTwoAdmins } from '../infrastructure/admin-user-adapter';

import type { AdminBoundLevelTwoAdminPage } from './admin-user-management.types';

const SEARCH_DEBOUNCE_MS = 300;
const DEFAULT_PAGE_SIZE = 8;

export type AdminBoundLevelTwoAdminListState =
  | { status: 'idle'; requestSeq: number }
  | { status: 'loading'; requestSeq: number }
  | { status: 'ready'; page: AdminBoundLevelTwoAdminPage; requestSeq: number }
  | { status: 'failed'; message: string; requestSeq: number };

type Action =
  | { type: 'load-start'; requestId: number }
  | { type: 'load-ready'; requestId: number; page: AdminBoundLevelTwoAdminPage }
  | { type: 'load-failed'; requestId: number; message: string }
  | { type: 'reset'; requestId: number };

function reducer(
  state: AdminBoundLevelTwoAdminListState,
  action: Action,
): AdminBoundLevelTwoAdminListState {
  switch (action.type) {
    case 'reset':
      return { requestSeq: action.requestId, status: 'idle' };
    case 'load-start':
      return { requestSeq: action.requestId, status: 'loading' };
    case 'load-ready':
      if (action.requestId !== state.requestSeq) {
        return state;
      }

      return { page: action.page, requestSeq: action.requestId, status: 'ready' };
    case 'load-failed':
      if (action.requestId !== state.requestSeq) {
        return state;
      }

      return { message: action.message, requestSeq: action.requestId, status: 'failed' };
  }
}

function toListUserMessage(error: unknown): string {
  return isGraphQLIngressError(error)
    ? error.userMessage
    : '已绑定二级管理员加载失败，请稍后重试。';
}

export function useAdminBoundLevelTwoAdmins(params: { enabled: boolean; pageSize?: number }) {
  const { enabled, pageSize = DEFAULT_PAGE_SIZE } = params;
  const [keywordDraft, setKeywordDraft] = useState('');
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [reloadTick, setReloadTick] = useState(0);
  const [state, dispatch] = useReducer(reducer, { requestSeq: 0, status: 'idle' });
  const requestIdRef = useRef(0);

  // 关键字防抖：到期后同时复位到第 1 页，避免旧页码与新关键字组合成空结果
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedKeyword(keywordDraft);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [keywordDraft]);

  useEffect(() => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;

    if (!enabled) {
      dispatch({ type: 'reset', requestId });
      return;
    }

    let cancelled = false;

    async function load() {
      dispatch({ type: 'load-start', requestId });

      try {
        const result = await fetchAdminBoundLevelTwoAdmins({
          keyword: debouncedKeyword.trim() === '' ? null : debouncedKeyword.trim(),
          page,
          pageSize,
        });

        if (!cancelled) {
          dispatch({ type: 'load-ready', requestId, page: result });
        }
      } catch (error) {
        if (!isGraphQLIngressError(error)) {
          console.error('已绑定二级管理员加载出现未分类错误：', error);
        }

        if (!cancelled) {
          dispatch({ type: 'load-failed', requestId, message: toListUserMessage(error) });
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [enabled, debouncedKeyword, page, pageSize, reloadTick]);

  /** 关闭弹窗时清空检索与页码：下次打开是全新会话，不残留上一目标的关键字 */
  const reset = useCallback(() => {
    setKeywordDraft('');
    setDebouncedKeyword('');
    setPage(1);
  }, []);

  const goToPage = useCallback((nextPage: number) => {
    setPage((previous) => (previous === nextPage ? previous : nextPage));
  }, []);

  const retry = useCallback(() => {
    setReloadTick((previous) => previous + 1);
  }, []);

  return { goToPage, keywordDraft, reset, retry, setKeywordDraft, state };
}
