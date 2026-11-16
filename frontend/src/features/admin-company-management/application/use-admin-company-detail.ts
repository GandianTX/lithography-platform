// src/features/admin-company-management/application/use-admin-company-detail.ts

/**
 * 公司档案详情读取（use case / query）。
 *
 * 详情入口按目标主键单独向后端读取，不复用列表行快照：列表可能已过期，
 * 而详情弹窗的职责是给出当前落库事实。请求代次用于丢弃过期响应：
 * 连续打开不同公司时，旧请求晚到不得覆盖当前目标。
 */

import { useCallback, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import { fetchAdminCompanyDetail } from '../infrastructure/admin-company-adapter';

import type { AdminCompanyRow } from './admin-company-management.types';

export type AdminCompanyDetailState =
  | { status: 'idle' }
  | { status: 'loading'; organizationId: number }
  | { status: 'ready'; organization: AdminCompanyRow }
  | { status: 'failed'; message: string; organizationId: number };

const FALLBACK_MESSAGE = '公司档案加载失败，请稍后重试。';

export function useAdminCompanyDetail() {
  const [state, setState] = useState<AdminCompanyDetailState>({ status: 'idle' });
  const requestIdRef = useRef(0);

  const open = useCallback(async (organizationId: number) => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;

    setState({ status: 'loading', organizationId });

    try {
      const result = await fetchAdminCompanyDetail(organizationId);

      if (requestId !== requestIdRef.current) {
        return;
      }

      setState(
        result.ok
          ? { status: 'ready', organization: result.organization }
          : { status: 'failed', message: result.message, organizationId },
      );
    } catch (error) {
      if (requestId !== requestIdRef.current) {
        return;
      }

      if (!isGraphQLIngressError(error)) {
        console.error('公司档案详情加载出现未分类错误：', error);
      }

      setState({
        status: 'failed',
        message: isGraphQLIngressError(error) ? error.userMessage : FALLBACK_MESSAGE,
        organizationId,
      });
    }
  }, []);

  const close = useCallback(() => {
    requestIdRef.current += 1;
    setState({ status: 'idle' });
  }, []);

  return { close, open, state };
}
