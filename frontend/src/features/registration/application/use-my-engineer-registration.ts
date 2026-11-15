// src/features/registration/application/use-my-engineer-registration.ts

/**
 * 受限会话读取本人最新工程师申请的状态机。
 *
 * - 只在受限页挂载时发起一次请求；`retry` 供失败后重试；
 * - 请求序号保护：重试或组件卸载后返回的旧结果不得覆盖新状态；
 * - 无申请记录（服务端 NOT_FOUND）是正常态（`application: null`），不是失败；
 * - 未分类错误只写控制台，对用户收敛为固定文案。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import { fetchMyEngineerRegistration } from '../infrastructure/my-engineer-registration-adapter';

import type { MyEngineerRegistrationView } from './registration.types';

const LOAD_FAILED_MESSAGE = '申请信息加载失败，请稍后重试。';

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
        setState({ message: LOAD_FAILED_MESSAGE, status: 'failed' });
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

  return { retry, state };
}
