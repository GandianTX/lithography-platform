// src/features/admin-engineer-approval/application/use-admin-engineer-registration-list.ts

/**
 * 工程师注册审批队列查询状态机（use case / query）。
 *
 * - 服务端分页与状态筛选全部下发后端；作用域由服务端按会话等级裁决，
 *   前端不传组织参数，避免客户端自报范围；
 * - query 对象是唯一查询游标：筛选或翻页都通过替换 query 触发重新加载，
 *   筛选变化回到第 1 页；
 * - 请求序号随状态原子更新：快速切换筛选或翻页后，旧请求返回不会覆盖当前结果；
 * - auth 类错误不在这里特殊处理，仍由共享 GraphQL + auth-session 全局链路负责。
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import { fetchAdminEngineerRegistrations } from '../infrastructure/admin-engineer-approval-adapter';

import type {
  AdminEngineerRegistrationListPage,
  AdminEngineerRegistrationListQuery,
} from './admin-engineer-approval.types';

export type AdminEngineerRegistrationListState =
  | {
      lastTotal: number;
      queryDomain: AdminEngineerRegistrationQueryDomain;
      status: 'loading';
      requestSeq: number;
    }
  | {
      lastTotal: number;
      page: AdminEngineerRegistrationListPage;
      queryDomain: AdminEngineerRegistrationQueryDomain;
      status: 'ready';
      requestSeq: number;
    }
  | {
      lastTotal: number;
      message: string;
      queryDomain: AdminEngineerRegistrationQueryDomain;
      status: 'failed';
      requestSeq: number;
    };

/** total 的查询域不含 page：同筛选域内翻页、reload 与失败重试可复用最近成功 total */
type AdminEngineerRegistrationQueryDomain = Pick<
  AdminEngineerRegistrationListQuery,
  'pageSize' | 'status'
>;

function toQueryDomain(
  query: AdminEngineerRegistrationListQuery,
): AdminEngineerRegistrationQueryDomain {
  return { pageSize: query.pageSize, status: query.status };
}

function isSameQueryDomain(
  left: AdminEngineerRegistrationQueryDomain,
  right: AdminEngineerRegistrationQueryDomain,
): boolean {
  return left.status === right.status && left.pageSize === right.pageSize;
}

type ListAction =
  | { type: 'load-start'; requestId: number; queryDomain: AdminEngineerRegistrationQueryDomain }
  | {
      type: 'load-ready';
      requestId: number;
      page: AdminEngineerRegistrationListPage;
      queryDomain: AdminEngineerRegistrationQueryDomain;
    }
  | { type: 'load-failed'; requestId: number; message: string };

function toListUserMessage(error: unknown): string {
  return isGraphQLIngressError(error) ? error.userMessage : '注册审批队列加载失败，请稍后重试。';
}

function listReducer(
  state: AdminEngineerRegistrationListState,
  action: ListAction,
): AdminEngineerRegistrationListState {
  switch (action.type) {
    case 'load-start':
      return {
        lastTotal: isSameQueryDomain(state.queryDomain, action.queryDomain)
          ? state.status === 'ready'
            ? state.page.total
            : state.lastTotal
          : 0,
        queryDomain: action.queryDomain,
        status: 'loading',
        requestSeq: action.requestId,
      };
    case 'load-ready':
      if (action.requestId !== state.requestSeq) {
        return state;
      }

      return {
        lastTotal: action.page.total,
        page: action.page,
        queryDomain: action.queryDomain,
        status: 'ready',
        requestSeq: action.requestId,
      };
    case 'load-failed':
      if (action.requestId !== state.requestSeq) {
        return state;
      }

      return {
        lastTotal: state.lastTotal,
        message: action.message,
        queryDomain: state.queryDomain,
        status: 'failed',
        requestSeq: action.requestId,
      };
  }
}

function createInitialQuery(pageSize: number): AdminEngineerRegistrationListQuery {
  return { page: 1, pageSize, status: null };
}

export function useAdminEngineerRegistrationList(pageSize = 10) {
  const [state, dispatch] = useReducer(listReducer, {
    lastTotal: 0,
    queryDomain: toQueryDomain(createInitialQuery(pageSize)),
    status: 'loading',
    requestSeq: 0,
  } as AdminEngineerRegistrationListState);
  const requestIdRef = useRef(0);
  const [query, setQuery] = useState<AdminEngineerRegistrationListQuery>(() =>
    createInitialQuery(pageSize),
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      requestIdRef.current += 1;
      const requestId = requestIdRef.current;
      const queryDomain = toQueryDomain(query);

      dispatch({ type: 'load-start', requestId, queryDomain });

      try {
        const page = await fetchAdminEngineerRegistrations(query);

        if (!cancelled) {
          dispatch({ type: 'load-ready', requestId, page, queryDomain });
        }
      } catch (error) {
        if (!isGraphQLIngressError(error)) {
          // 非 ingress 错误（如 mapper 守卫抛出）原始信息只保留在控制台，
          // 避免收敛文案后线上无法排障
          console.error('注册审批队列加载出现未分类错误：', error);
        }

        if (!cancelled) {
          dispatch({ type: 'load-failed', requestId, message: toListUserMessage(error) });
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [query]);

  /** 提交状态筛选：回到第 1 页并重新加载 */
  const applyFilters = useCallback(
    (patch: Partial<Pick<AdminEngineerRegistrationListQuery, 'status'>>) => {
      setQuery((previous) => ({ ...previous, page: 1, ...patch }));
    },
    [],
  );

  const goToPage = useCallback((page: number) => {
    setQuery((previous) => (previous.page === page ? previous : { ...previous, page }));
  }, []);

  /** 按当前游标重新加载（写命令成功 / 并发冲突后的统一刷新策略） */
  const reload = useCallback(() => {
    setQuery((previous) => ({ ...previous }));
  }, []);

  const isCurrentQueryDomain = isSameQueryDomain(state.queryDomain, toQueryDomain(query));

  return { state, query, isCurrentQueryDomain, applyFilters, goToPage, reload };
}
