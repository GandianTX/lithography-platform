// src/features/my-records/application/use-my-record-detail.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import type { MyRecordDetail } from '../infrastructure/my-records.types';
import { fetchMyRecord } from '../infrastructure/my-records-adapter';

type MyRecordDetailState =
  | { status: 'loading'; requestSeq: number }
  | { status: 'ready'; requestSeq: number; detail: MyRecordDetail }
  | { status: 'not-found'; requestSeq: number; message: string }
  | { status: 'failed'; requestSeq: number; message: string };

type MyRecordDetailAction =
  | { type: 'load-start'; requestSeq: number }
  | { type: 'load-ready'; requestSeq: number; detail: MyRecordDetail }
  | { type: 'load-not-found'; requestSeq: number; message: string }
  | { type: 'load-failed'; requestSeq: number; message: string }
  | { type: 'load-invalid-id'; requestSeq: number };

const INVALID_ID_MESSAGE = '记录不存在或不可查看。';

function toUserMessage(error: unknown): string {
  return isGraphQLIngressError(error) ? error.userMessage : '记录加载失败，请稍后重试。';
}

function myRecordDetailReducer(
  state: MyRecordDetailState,
  action: MyRecordDetailAction,
): MyRecordDetailState {
  switch (action.type) {
    case 'load-start':
      return { status: 'loading', requestSeq: action.requestSeq };
    case 'load-ready':
      if (action.requestSeq !== state.requestSeq) {
        return state;
      }

      return { status: 'ready', requestSeq: action.requestSeq, detail: action.detail };
    case 'load-not-found':
      if (action.requestSeq !== state.requestSeq) {
        return state;
      }

      return { status: 'not-found', requestSeq: action.requestSeq, message: action.message };
    case 'load-failed':
      if (action.requestSeq !== state.requestSeq) {
        return state;
      }

      return { status: 'failed', requestSeq: action.requestSeq, message: action.message };
    case 'load-invalid-id':
      return { status: 'not-found', requestSeq: action.requestSeq, message: INVALID_ID_MESSAGE };
  }
}

/**
 * 本人记录详情流程（query 状态机）：
 * 他人 / 跨公司 / 不存在 / 角色拒绝由 adapter 统一归并 not-found（防探测）；
 * recordId 为 null（路由参数非法）不发请求，直接进入统一 not-found 口径；
 * 请求序号防竞态：快速切换记录后旧结果不覆盖当前目标。
 */
export function useMyRecordDetail(recordId: number | null) {
  const [state, dispatch] = useReducer(myRecordDetailReducer, {
    status: 'loading',
    requestSeq: 0,
  } as MyRecordDetailState);
  const requestSeqRef = useRef(0);

  const loadDetail = useCallback(async (targetId: number, requestSeq: number) => {
    dispatch({ type: 'load-start', requestSeq });

    try {
      const result = await fetchMyRecord(targetId);

      if (result.ok) {
        dispatch({ type: 'load-ready', requestSeq, detail: result.detail });
      } else {
        dispatch({ type: 'load-not-found', requestSeq, message: result.message });
      }
    } catch (error) {
      dispatch({ type: 'load-failed', requestSeq, message: toUserMessage(error) });
    }
  }, []);

  useEffect(() => {
    requestSeqRef.current += 1;

    if (recordId === null) {
      dispatch({ type: 'load-invalid-id', requestSeq: requestSeqRef.current });
      return;
    }

    void loadDetail(recordId, requestSeqRef.current);
  }, [recordId, loadDetail]);

  const reload = useCallback(() => {
    if (recordId === null) {
      return;
    }

    requestSeqRef.current += 1;

    void loadDetail(recordId, requestSeqRef.current);
  }, [recordId, loadDetail]);

  return { state, reload };
}
