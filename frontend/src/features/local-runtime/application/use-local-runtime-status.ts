// src/features/local-runtime/application/use-local-runtime-status.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import type { LocalRuntimeStatus } from '../infrastructure/local-runtime.types';
import { fetchLocalRuntimeStatus } from '../infrastructure/local-runtime-graphql-adapter';

/**
 * 本地设置页只读状态（任务 09 R064）。
 *
 * 竞态防护与同仓库列表/统计 hook 同级：以 `requestIdRef` 为序号唯一真源，
 * 晚到的旧响应（重试与首屏挂载重叠、切换账号后旧会话响应）一律丢弃，
 * 避免"上一账号的状态覆盖当前账号"。
 *
 * 失败不做乐观降级：不展示缓存值、不伪造"运行正常"，只给可重试的失败态。
 */
export type LocalRuntimeStatusState =
  | { status: 'loading'; requestId: number }
  | { status: 'ready'; requestId: number; data: LocalRuntimeStatus }
  | { status: 'failed'; requestId: number; message: string };

type LocalRuntimeStatusAction =
  | { type: 'load-start'; requestId: number }
  | { type: 'load-ready'; requestId: number; data: LocalRuntimeStatus }
  | { type: 'load-failed'; requestId: number; message: string };

function localRuntimeStatusReducer(
  state: LocalRuntimeStatusState,
  action: LocalRuntimeStatusAction,
): LocalRuntimeStatusState {
  switch (action.type) {
    case 'load-start':
      return { status: 'loading', requestId: action.requestId };
    case 'load-ready':
      if (action.requestId !== state.requestId) {
        return state;
      }

      return { status: 'ready', requestId: action.requestId, data: action.data };
    case 'load-failed':
      if (action.requestId !== state.requestId) {
        return state;
      }

      return { status: 'failed', requestId: action.requestId, message: action.message };
  }
}

export function useLocalRuntimeStatus() {
  const [state, dispatch] = useReducer(localRuntimeStatusReducer, {
    status: 'loading',
    requestId: 0,
  } as LocalRuntimeStatusState);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;

    dispatch({ type: 'load-start', requestId });

    try {
      const data = await fetchLocalRuntimeStatus();
      dispatch({ type: 'load-ready', requestId, data });
    } catch (error) {
      dispatch({
        type: 'load-failed',
        requestId,
        message: isGraphQLIngressError(error)
          ? error.userMessage
          : '本机状态读取失败，请稍后重试。',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { state, reload: load };
}
