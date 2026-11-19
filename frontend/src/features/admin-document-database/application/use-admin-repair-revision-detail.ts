// src/features/admin-document-database/application/use-admin-repair-revision-detail.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';
import { translateNow } from '@/shared/i18n';

import type { AdminRepairRequestRevisionDetail } from '../infrastructure/admin-document-database.types';
import { fetchAdminRepairRequestRevisionDetail } from '../infrastructure/admin-document-database-adapter';

export type AdminRevisionDetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; detail: AdminRepairRequestRevisionDetail }
  | { status: 'failed'; message: string };

type Action =
  | { type: 'load-start' }
  | { type: 'load-ready'; detail: AdminRepairRequestRevisionDetail }
  | { type: 'load-failed'; message: string }
  | { type: 'reset' };

function reducer(_state: AdminRevisionDetailState, action: Action): AdminRevisionDetailState {
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
 * 管理员修订版本详情（查看版本 / 对比上一版）按需读取。
 *
 * revisionNo 为 null 时不发请求；选择变化即重读并丢弃旧响应，
 * 业务拒绝显示在弹窗内，transport 失败可重试。
 */
export function useAdminRepairRevisionDetail(requestId: number, revisionNo: number | null) {
  const [state, dispatch] = useReducer(reducer, { status: 'idle' });
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
        const result = await fetchAdminRepairRequestRevisionDetail(requestId, targetRevisionNo);
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
            : translateNow('adminRepairRequest.versionHistory.detailFailed'),
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
