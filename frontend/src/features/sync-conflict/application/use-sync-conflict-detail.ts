// src/features/sync-conflict/application/use-sync-conflict-detail.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import type { SyncConflictAction, SyncConflictDetail } from '../infrastructure/sync-conflict.types';
import {
  fetchSyncConflictDetail,
  resolveSyncConflict,
} from '../infrastructure/sync-conflict-adapter';

type SyncConflictDetailState =
  | { status: 'loading'; requestSeq: number }
  | { status: 'ready'; requestSeq: number; detail: SyncConflictDetail }
  | { status: 'failed'; requestSeq: number; message: string };

type SyncConflictDetailAction =
  | { type: 'load-start'; requestSeq: number }
  | { type: 'load-ready'; requestSeq: number; detail: SyncConflictDetail }
  | { type: 'load-failed'; requestSeq: number; message: string };

function toUserMessage(error: unknown): string {
  return isGraphQLIngressError(error) ? error.userMessage : '同步冲突详情加载失败，请稍后重试。';
}

function syncConflictDetailReducer(
  state: SyncConflictDetailState,
  action: SyncConflictDetailAction,
): SyncConflictDetailState {
  switch (action.type) {
    case 'load-start':
      return { status: 'loading', requestSeq: action.requestSeq };
    case 'load-ready':
      if (action.requestSeq !== state.requestSeq) {
        return state;
      }
      return { status: 'ready', requestSeq: action.requestSeq, detail: action.detail };
    case 'load-failed':
      if (action.requestSeq !== state.requestSeq) {
        return state;
      }
      return { status: 'failed', requestSeq: action.requestSeq, message: action.message };
  }
}

/**
 * 冲突详情与裁决流程。
 *
 * - 裁决动作由服务端裁决，前端只负责发起并如实展示返回的 outcome；
 * - 裁决后重新拉取详情，避免本地留一份与事实不一致的旧快照；
 * - 只读内容（已删除／下架／冻结／结单）由服务端拒绝，页面据此提前禁用动作并说明原因。
 */
export function useSyncConflictDetail(conflictId: string) {
  const [state, dispatch] = useReducer(syncConflictDetailReducer, {
    status: 'loading',
    requestSeq: 0,
  } as SyncConflictDetailState);
  const requestSeqRef = useRef(0);
  // 裁决进行中标记：用计数器而不是布尔量，避免并发裁决时提前解除 loading
  const [resolvingCount, setResolvingCount] = useReducer((count: number) => count + 1, 0);

  const loadDetail = useCallback(async () => {
    requestSeqRef.current += 1;
    const requestSeq = requestSeqRef.current;

    dispatch({ type: 'load-start', requestSeq });

    try {
      const detail = await fetchSyncConflictDetail(conflictId);
      dispatch({ type: 'load-ready', requestSeq, detail });
    } catch (error) {
      dispatch({ type: 'load-failed', requestSeq, message: toUserMessage(error) });
    }
  }, [conflictId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const resolve = useCallback(
    async (action: SyncConflictAction) => {
      setResolvingCount();
      try {
        await resolveSyncConflict(conflictId, action);
        await loadDetail();
        return { ok: true as const };
      } catch (error) {
        return { ok: false as const, message: toUserMessage(error) };
      } finally {
        setResolvingCount();
      }
    },
    [conflictId, loadDetail],
  );

  return { state, resolve, resolving: resolvingCount % 2 === 1 };
}
