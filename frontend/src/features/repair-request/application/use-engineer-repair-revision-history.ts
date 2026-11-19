// src/features/repair-request/application/use-engineer-repair-revision-history.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';
import { translateNow } from '@/shared/i18n';

import type {
  EngineerRepairRevisionDetail,
  EngineerRepairRevisionHistoryItem,
} from '../infrastructure/engineer-repair-request.types';
import {
  fetchEngineerRepairRequestRevisionDetail,
  fetchEngineerRepairRequestRevisionHistory,
} from '../infrastructure/engineer-repair-request-adapter';

export type EngineerRevisionHistoryState =
  | { status: 'loading' }
  | { status: 'ready'; items: EngineerRepairRevisionHistoryItem[] }
  | { status: 'failed'; message: string };

type HistoryAction =
  | { type: 'load-start' }
  | { type: 'load-ready'; items: EngineerRepairRevisionHistoryItem[] }
  | { type: 'load-failed'; message: string };

function historyReducer(
  _state: EngineerRevisionHistoryState,
  action: HistoryAction,
): EngineerRevisionHistoryState {
  switch (action.type) {
    case 'load-start':
      return { status: 'loading' };
    case 'load-ready':
      return { status: 'ready', items: action.items };
    case 'load-failed':
      return { status: 'failed', message: action.message };
  }
}

/**
 * 工程师侧修订历史（只读）。
 *
 * 失败只在历史区块内提示，不影响工单详情与当前维修记录；
 * 重新挂载或调用 retry 会重新读取。
 */
export function useEngineerRepairRevisionHistory(requestId: number) {
  const [state, dispatch] = useReducer(historyReducer, { status: 'loading' });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    dispatch({ type: 'load-start' });
    try {
      const result = await fetchEngineerRepairRequestRevisionHistory(requestId);
      if (!mountedRef.current) return;
      if (result.ok) {
        dispatch({ type: 'load-ready', items: result.items });
      } else {
        dispatch({ type: 'load-failed', message: result.message });
      }
    } catch (error) {
      if (!mountedRef.current) return;
      dispatch({
        type: 'load-failed',
        message: isGraphQLIngressError(error)
          ? error.userMessage
          : translateNow('engineerRepairHistory.loadFailed'),
      });
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { state, retry: load };
}

export type EngineerRevisionDetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; detail: EngineerRepairRevisionDetail }
  | { status: 'failed'; message: string };

type DetailAction =
  | { type: 'load-start' }
  | { type: 'load-ready'; detail: EngineerRepairRevisionDetail }
  | { type: 'load-failed'; message: string }
  | { type: 'reset' };

function detailReducer(
  _state: EngineerRevisionDetailState,
  action: DetailAction,
): EngineerRevisionDetailState {
  switch (action.type) {
    case 'load-start':
      return { status: 'loading' };
    case 'load-ready':
      return { status: 'ready', detail: action.detail };
    case 'load-failed':
      return { status: 'failed', message: action.message };
    case 'reset':
      return { status: 'idle' };
  }
}

/**
 * 工程师侧单个修订详情按需读取；revisionNo 为 null 时不发请求。
 */
export function useEngineerRepairRevisionDetail(requestId: number, revisionNo: number | null) {
  const [state, dispatch] = useReducer(detailReducer, { status: 'idle' });
  const sequenceRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(
    async (targetRevisionNo: number) => {
      sequenceRef.current += 1;
      const sequence = sequenceRef.current;
      dispatch({ type: 'load-start' });
      try {
        const result = await fetchEngineerRepairRequestRevisionDetail(requestId, targetRevisionNo);
        if (!mountedRef.current || sequence !== sequenceRef.current) return;
        if (result.ok) {
          dispatch({ type: 'load-ready', detail: result.detail });
        } else {
          dispatch({ type: 'load-failed', message: result.message });
        }
      } catch (error) {
        if (!mountedRef.current || sequence !== sequenceRef.current) return;
        dispatch({
          type: 'load-failed',
          message: isGraphQLIngressError(error)
            ? error.userMessage
            : translateNow('engineerRepairHistory.detailFailed'),
        });
      }
    },
    [requestId],
  );

  useEffect(() => {
    if (revisionNo === null) {
      sequenceRef.current += 1;
      dispatch({ type: 'reset' });
      return;
    }
    void load(revisionNo);
  }, [load, revisionNo]);

  const retry = useCallback(() => {
    if (revisionNo !== null) {
      void load(revisionNo);
    }
  }, [load, revisionNo]);

  return { state, retry };
}
