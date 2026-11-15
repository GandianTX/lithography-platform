// src/features/admin-engineer-approval/application/use-admin-engineer-registration-detail.ts

/**
 * 申请详情读取（use case / query）。
 *
 * 详情入口按目标主键单独向后端读取，不复用列表行快照：列表可能已过期，
 * 而详情弹窗的职责是给出当前落库事实。请求代次用于丢弃过期响应：
 * 连续打开不同申请时，旧请求晚到不得覆盖当前目标。
 */

import { useCallback, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import { fetchAdminEngineerRegistrationDetail } from '../infrastructure/admin-engineer-approval-adapter';

import type { AdminEngineerRegistrationRow } from './admin-engineer-approval.types';

export type AdminEngineerRegistrationDetailState =
  | { status: 'idle' }
  | { status: 'loading'; applicationId: number }
  | { status: 'ready'; registration: AdminEngineerRegistrationRow }
  | { status: 'failed'; applicationId: number; message: string };

const FALLBACK_MESSAGE = '注册申请详情加载失败，请稍后重试。';

export function useAdminEngineerRegistrationDetail() {
  const [state, setState] = useState<AdminEngineerRegistrationDetailState>({ status: 'idle' });
  const requestIdRef = useRef(0);

  const open = useCallback(async (applicationId: number) => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;

    setState({ status: 'loading', applicationId });

    try {
      const result = await fetchAdminEngineerRegistrationDetail(applicationId);

      if (requestId !== requestIdRef.current) {
        return;
      }

      setState(
        result.ok
          ? { status: 'ready', registration: result.registration }
          : { status: 'failed', applicationId, message: result.message },
      );
    } catch (error) {
      if (requestId !== requestIdRef.current) {
        return;
      }

      if (!isGraphQLIngressError(error)) {
        console.error('注册申请详情加载出现未分类错误：', error);
      }

      setState({
        applicationId,
        message: isGraphQLIngressError(error) ? error.userMessage : FALLBACK_MESSAGE,
        status: 'failed',
      });
    }
  }, []);

  const close = useCallback(() => {
    requestIdRef.current += 1;
    setState({ status: 'idle' });
  }, []);

  return { close, open, state };
}
