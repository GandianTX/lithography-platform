// src/features/admin-company-management/application/use-admin-company-list.ts

/**
 * 公司档案列表查询状态机（use case / query，收束在 feature application）。
 *
 * - 按读入口模式选择后端接口：一级 → 完整列表；二级 / 等级未知 → 最小名称名单；
 * - 服务端分页：page / pageSize / keyword / status / isServiceProvider 全部下发后端，
 *   不做前端全量读取后再分页；
 * - query 对象是唯一查询游标：筛选或翻页都通过替换 query 触发重新加载，
 *   筛选变化回到第 1 页；
 * - 请求序号随状态原子更新：快速切换筛选或翻页后，旧请求返回不会覆盖当前结果；
 * - auth 类错误不在这里特殊处理，仍由共享 GraphQL + auth-session 全局链路负责。
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import {
  fetchAdminCompanies,
  fetchAdminCompanyNames,
} from '../infrastructure/admin-company-adapter';

import type {
  AdminCompanyListMode,
  AdminCompanyListPage,
  AdminCompanyListQuery,
} from './admin-company-management.types';

export type AdminCompanyListState =
  | {
      lastTotal: number;
      queryDomain: AdminCompanyListQueryDomain;
      status: 'loading';
      requestSeq: number;
    }
  | {
      lastTotal: number;
      page: AdminCompanyListPage;
      queryDomain: AdminCompanyListQueryDomain;
      status: 'ready';
      requestSeq: number;
    }
  | {
      lastTotal: number;
      message: string;
      queryDomain: AdminCompanyListQueryDomain;
      status: 'failed';
      requestSeq: number;
    };

/** total 的查询域不含 page：同筛选域内翻页、reload 与失败重试可复用最近成功 total。 */
type AdminCompanyListQueryDomain = Pick<
  AdminCompanyListQuery,
  'isServiceProvider' | 'keyword' | 'pageSize' | 'status'
> & { mode: AdminCompanyListMode };

function toAdminCompanyListQueryDomain(
  query: AdminCompanyListQuery,
  mode: AdminCompanyListMode,
): AdminCompanyListQueryDomain {
  return {
    isServiceProvider: query.isServiceProvider,
    keyword: query.keyword,
    mode,
    pageSize: query.pageSize,
    status: query.status,
  };
}

function isSameAdminCompanyListQueryDomain(
  left: AdminCompanyListQueryDomain,
  right: AdminCompanyListQueryDomain,
): boolean {
  return (
    left.mode === right.mode &&
    left.keyword === right.keyword &&
    left.status === right.status &&
    left.isServiceProvider === right.isServiceProvider &&
    left.pageSize === right.pageSize
  );
}

type AdminCompanyListAction =
  | { type: 'load-start'; requestId: number; queryDomain: AdminCompanyListQueryDomain }
  | {
      type: 'load-ready';
      requestId: number;
      page: AdminCompanyListPage;
      queryDomain: AdminCompanyListQueryDomain;
    }
  | { type: 'load-failed'; requestId: number; message: string };

function toListUserMessage(error: unknown): string {
  return isGraphQLIngressError(error) ? error.userMessage : '公司档案加载失败，请稍后重试。';
}

function adminCompanyListReducer(
  state: AdminCompanyListState,
  action: AdminCompanyListAction,
): AdminCompanyListState {
  switch (action.type) {
    case 'load-start':
      return {
        lastTotal: isSameAdminCompanyListQueryDomain(state.queryDomain, action.queryDomain)
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

function createInitialQuery(pageSize: number): AdminCompanyListQuery {
  return {
    isServiceProvider: null,
    keyword: null,
    page: 1,
    pageSize,
    status: null,
  };
}

export function useAdminCompanyList(mode: AdminCompanyListMode, pageSize = 10) {
  const [state, dispatch] = useReducer(adminCompanyListReducer, {
    lastTotal: 0,
    queryDomain: toAdminCompanyListQueryDomain(createInitialQuery(pageSize), mode),
    status: 'loading',
    requestSeq: 0,
  } as AdminCompanyListState);
  const requestIdRef = useRef(0);
  const [query, setQuery] = useState<AdminCompanyListQuery>(() => createInitialQuery(pageSize));

  useEffect(() => {
    let cancelled = false;

    async function load() {
      requestIdRef.current += 1;
      const requestId = requestIdRef.current;
      const queryDomain = toAdminCompanyListQueryDomain(query, mode);

      dispatch({ type: 'load-start', requestId, queryDomain });

      try {
        const page =
          mode === 'full' ? await fetchAdminCompanies(query) : await fetchAdminCompanyNames(query);

        if (!cancelled) {
          dispatch({ type: 'load-ready', requestId, page, queryDomain });
        }
      } catch (error) {
        if (!isGraphQLIngressError(error)) {
          // 非 ingress 错误（如 mapper 守卫抛出）原始信息只保留在控制台，
          // 避免收敛文案后线上无法排障
          console.error('公司档案列表加载出现未分类错误：', error);
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
  }, [mode, query]);

  /** 提交筛选变化：回到第 1 页并重新加载 */
  const applyFilters = useCallback(
    (patch: Partial<Pick<AdminCompanyListQuery, 'isServiceProvider' | 'keyword' | 'status'>>) => {
      setQuery((previous) => ({ ...previous, page: 1, ...patch }));
    },
    [],
  );

  const goToPage = useCallback((page: number) => {
    setQuery((previous) => (previous.page === page ? previous : { ...previous, page }));
  }, []);

  /** 按当前游标重新加载（写命令成功后的统一刷新策略） */
  const reload = useCallback(() => {
    setQuery((previous) => ({ ...previous }));
  }, []);

  const isCurrentQueryDomain = isSameAdminCompanyListQueryDomain(
    state.queryDomain,
    toAdminCompanyListQueryDomain(query, mode),
  );

  return { state, query, isCurrentQueryDomain, applyFilters, goToPage, reload };
}
