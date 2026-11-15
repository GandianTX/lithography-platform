// src/features/registration/application/use-my-engineer-registration.ts

/**
 * 受限会话读取本人最新工程师申请的状态机。
 *
 * - 只在受限页挂载时发起一次请求；`retry` 供失败后重试；
 * - `refresh` 供常态显式刷新：当前已有数据时保留展示，直到新结果返回，
 *   避免刷新按钮把卡片打成骨架屏；
 * - 请求序号保护：重试、刷新或组件卸载后返回的旧结果不得覆盖新状态；
 * - 无申请记录（服务端 NOT_FOUND）是正常态（`application: null`），不是失败；
 * - 未分类错误只写控制台，对用户收敛为固定文案。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';
import { translateNow } from '@/shared/i18n';

import { fetchMyEngineerRegistration } from '../infrastructure/my-engineer-registration-adapter';

import type { MyEngineerRegistrationView } from './registration.types';

const LOAD_FAILED_MESSAGE_KEY = 'restricted.application.loadFailed' as const;

export type MyEngineerRegistrationState =
  | { status: 'loading' }
  | { message: string; status: 'failed' }
  | { application: MyEngineerRegistrationView | null; status: 'ready' };

export function useMyEngineerRegistration() {
  const [state, setState] = useState<MyEngineerRegistrationState>({ status: 'loading' });
  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);

  const fetchApplication = useCallback(async (seq: number) => {
    try {
      const application = await fetchMyEngineerRegistration();

      if (mountedRef.current && seq === requestSeqRef.current) {
        setState({ application, status: 'ready' });
      }
    } catch (error) {
      if (!isGraphQLIngressError(error)) {
        console.error('本人工程师申请加载出现未分类错误：', error);
      }

      if (mountedRef.current && seq === requestSeqRef.current) {
        setState({ message: translateNow(LOAD_FAILED_MESSAGE_KEY), status: 'failed' });
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    void fetchApplication(seq);

    return () => {
      mountedRef.current = false;
    };
  }, [fetchApplication]);

  const retry = useCallback(() => {
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    setState({ status: 'loading' });
    void fetchApplication(seq);
  }, [fetchApplication]);

  const refresh = useCallback(() => {
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    // 已有数据时保留当前展示（按钮自带 loading），空态/失败态仍回到 loading
    setState((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    void fetchApplication(seq);
  }, [fetchApplication]);

  return { refresh, retry, state };
}
