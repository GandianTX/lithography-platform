// src/features/reference-document/application/use-reference-document-editable-content.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import type { ReferenceDocumentEditableContent } from '../infrastructure/reference-document.types';
import { fetchReferenceDocumentEditableContent } from '../infrastructure/reference-document-adapter';

type EditableContentState =
  | { status: 'loading'; requestSeq: number }
  | { status: 'ready'; requestSeq: number; content: ReferenceDocumentEditableContent }
  | { status: 'failed'; requestSeq: number; message: string };

type EditableContentAction =
  | { type: 'load-start'; requestSeq: number }
  | { type: 'load-ready'; requestSeq: number; content: ReferenceDocumentEditableContent }
  | { type: 'load-failed'; requestSeq: number; message: string }
  | { type: 'load-invalid-id'; requestSeq: number };

function toUserMessage(error: unknown): string {
  return isGraphQLIngressError(error) ? error.userMessage : '编辑初值加载失败，请稍后重试。';
}

const INVALID_ID_MESSAGE = '参考资料不存在或不可访问。';

function editableContentReducer(
  state: EditableContentState,
  action: EditableContentAction,
): EditableContentState {
  switch (action.type) {
    case 'load-start':
      return { status: 'loading', requestSeq: action.requestSeq };
    case 'load-ready':
      if (action.requestSeq !== state.requestSeq) {
        return state;
      }
      return { status: 'ready', requestSeq: action.requestSeq, content: action.content };
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
 * 管理修订编辑初值读取（仅一级管理员；服务端按账号等级事实复核）。
 * documentId 变化与重试共用同一请求序号竞态保护（与详情/历史版本 hook 同模式）。
 */
export function useReferenceDocumentEditableContent(documentId: number | null) {
  const [state, dispatch] = useReducer(editableContentReducer, {
    status: 'loading',
    requestSeq: 0,
  } as EditableContentState);
  const requestSeqRef = useRef(0);

  const loadContent = useCallback(async (targetId: number, requestSeq: number) => {
    dispatch({ type: 'load-start', requestSeq });

    try {
      const result = await fetchReferenceDocumentEditableContent(targetId);
      if (result.ok) {
        dispatch({ type: 'load-ready', requestSeq, content: result.content });
      } else {
        dispatch({ type: 'load-failed', requestSeq, message: result.message });
      }
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

    void loadContent(documentId, requestSeqRef.current);
  }, [documentId, loadContent]);

  /** 失败重试：同一 documentId 重新发起请求（序号递增，旧响应被 reducer 丢弃） */
  const reload = useCallback(() => {
    if (documentId === null) {
      return;
    }

    requestSeqRef.current += 1;

    void loadContent(documentId, requestSeqRef.current);
  }, [documentId, loadContent]);

  return { state, reload };
}
