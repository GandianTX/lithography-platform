// src/features/admin-company-management/application/use-admin-company-admin-account-detail.ts

/**
 * 二级管理员账号详情读取（按需窄查询）。
 *
 * 列表读面只保留状态与脱敏登录名；点击行内入口时才按公司主键发一次查询，
 * 获取完整登录名与开通状态。请求代次用于丢弃过期响应：连续打开不同公司时，
 * 旧请求晚到不得覆盖当前目标；关闭与卸载同样推进代次，避免晚到响应写回已销毁状态。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import { fetchAdminCompanyAdminAccountDetail } from '../infrastructure/admin-company-adapter';

import type { AdminCompanyAdminAccountDetail } from './admin-company-management.types';

export type AdminCompanyAdminAccountDetailState =
  | { status: 'idle' }
  | { status: 'loading'; organizationId: number }
  | { status: 'ready'; detail: AdminCompanyAdminAccountDetail }
  | { status: 'failed'; message: string; organizationId: number };

const FALLBACK_MESSAGE = '账号详情加载失败，请稍后重试。';

export function useAdminCompanyAdminAccountDetail() {
  const [state, setState] = useState<AdminCompanyAdminAccountDetailState>({ status: 'idle' });
  const requestIdRef = useRef(0);
  const lastOrganizationIdRef = useRef<number | null>(null);

  const open = useCallback(async (organizationId: number) => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    lastOrganizationIdRef.current = organizationId;

    setState({ status: 'loading', organizationId });

    try {
      const result = await fetchAdminCompanyAdminAccountDetail(organizationId);

      if (requestId !== requestIdRef.current) {
        return;
      }

      setState(
        result.ok
          ? { status: 'ready', detail: result.detail }
          : { status: 'failed', message: result.message, organizationId },
      );
    } catch (error) {
      if (requestId !== requestIdRef.current) {
        return;
      }

      if (!isGraphQLIngressError(error)) {
        console.error('二级管理员账号详情加载出现未分类错误：', error);
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

  const retry = useCallback(() => {
    const organizationId = lastOrganizationIdRef.current;

    if (organizationId !== null) {
      void open(organizationId);
    }
  }, [open]);

  useEffect(
    () => () => {
      // 卸载后晚到的响应不再写状态
      requestIdRef.current += 1;
    },
    [],
  );

  return { close, open, retry, state };
}
