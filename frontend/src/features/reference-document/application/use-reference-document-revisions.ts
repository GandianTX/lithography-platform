// src/features/reference-document/application/use-reference-document-revisions.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import type { ReferenceDocumentRevisions } from '../infrastructure/reference-document.types';
import { fetchReferenceDocumentRevisions } from '../infrastructure/reference-document-adapter';

type RevisionsState =
  | { status: 'loading'; requestSeq: number }
  | { status: 'ready'; requestSeq: number; revisions: ReferenceDocumentRevisions }
  | { status: 'failed'; requestSeq: number; message: string };

type RevisionsAction =
  | { type: 'load-start'; requestSeq: number }
  | { type: 'load-ready'; requestSeq: number; revisions: ReferenceDocumentRevisions }
  | { type: 'load-failed'; requestSeq: number; message: string }
  | { type: 'load-invalid-id'; requestSeq: number };

function toUserMessage(error: unknown): string {
  return isGraphQLIngressError(error) ? error.userMessage : '历史版本加载失败，请稍后重试。';
}

const INVALID_ID_MESSAGE = '历史维修记录不存在或不可查看。';

function revisionsReducer(state: RevisionsState, action: RevisionsAction): RevisionsState {
  switch (action.type) {
    case 'load-start':
      // 原子切换 loading 并记录序号：旧请求结果随后返回时被 reducer 丢弃
      return { status: 'loading', requestSeq: action.requestSeq };
    case 'load-ready':
      if (action.requestSeq !== state.requestSeq) {
        return state;
      }

      return { status: 'ready', requestSeq: action.requestSeq, revisions: action.revisions };
    case 'load-failed':
      if (action.requestSeq !== state.requestSeq) {
        return state;
      }

      return { status: 'failed', requestSeq: action.requestSeq, message: action.message };
    case 'load-invalid-id':
      return {
        status: 'failed',
        requestSeq: action.requestSeq,
        message: INVALID_ID_MESSAGE,
      };
  }
}

/**
 * 历史版本读取（与详情同一可见范围）。
 * 不可见资料由服务端统一 NOT_FOUND，这里按失败态展示，不伪造空历史；
 * documentId 变化与重试共用同一请求序号竞态保护（与详情 hook 同模式）。
 */
export function useReferenceDocumentRevisions(documentId: number | null) {
  const [state, dispatch] = useReducer(revisionsReducer, {
    status: 'loading',
    requestSeq: 0,
  } as RevisionsState);
  const requestSeqRef = useRef(0);

  const loadRevisions = useCallback(async (targetId: number, requestSeq: number) => {
    dispatch({ type: 'load-start', requestSeq });

    try {
      const revisions = await fetchReferenceDocumentRevisions(targetId);
      dispatch({ type: 'load-ready', requestSeq, revisions });
    } catch (error) {
      dispatch({ type: 'load-failed', requestSeq, message: toUserMessage(error) });
    }
  }, []);

  useEffect(() => {
    requestSeqRef.current += 1;

    if (documentId === null) {
      dispatch({ type: 'load-invalid-id', requestSeq: requestSeqRef.current });
      return;
    }

    void loadRevisions(documentId, requestSeqRef.current);
  }, [documentId, loadRevisions]);

  return { state };
}
