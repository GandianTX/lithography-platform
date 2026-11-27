// src/features/admin-document-database/application/use-admin-document-stats.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import type { AdminDocumentDatabaseStats } from '../infrastructure/admin-document-database.types';
import { fetchAdminDocumentDatabaseStats } from '../infrastructure/admin-document-database-adapter';

/**
 * 页头四类真实统计（PR3 S3）：一次聚合查询，口径与各标签默认列表过滤一致
 * （历史维修记录/维修申请不含软删除，由后端统计查询保证），禁止前端拼凑或
 * 用当前页条数冒充总数（计划表 S3-3）。
 *
 * 竞态防护与同 feature 的列表 / 详情 hook 同级：以 requestIdRef 为序号唯一真源，
 * 每次 load/reload 递增并随 action 携带，reducer 丢弃 requestId 不匹配的晚到旧响应。
 * reload 由失败态重试按钮触发，可能与在途的初次挂载请求重叠，若无保护则「旧统计
 * 晚到覆盖新 reload」——此为负责人历轮高发打回点（同 feature 防护对齐 / 状态机分支穷举）。
 */

export type AdminDocumentStatsState =
  | { status: 'loading'; requestId: number }
  | { status: 'ready'; requestId: number; stats: AdminDocumentDatabaseStats }
  | { status: 'failed'; requestId: number; message: string };

type AdminDocumentStatsAction =
  | { type: 'load-start'; requestId: number }
  | { type: 'load-ready'; requestId: number; stats: AdminDocumentDatabaseStats }
  | { type: 'load-failed'; requestId: number; message: string };

function adminDocumentStatsReducer(
  state: AdminDocumentStatsState,
  action: AdminDocumentStatsAction,
): AdminDocumentStatsState {
  switch (action.type) {
    case 'load-start':
      return { status: 'loading', requestId: action.requestId };
    case 'load-ready':
      if (action.requestId !== state.requestId) {
        return state;
      }

      return { status: 'ready', requestId: action.requestId, stats: action.stats };
    case 'load-failed':
      if (action.requestId !== state.requestId) {
        return state;
      }

      return { status: 'failed', requestId: action.requestId, message: action.message };
  }
}

export function useAdminDocumentStats() {
  const [state, dispatch] = useReducer(adminDocumentStatsReducer, {
    status: 'loading',
    requestId: 0,
  } as AdminDocumentStatsState);
  // 序号唯一真源：只在此 ref 上自增，不从派生 state 反推（避免并发同基数失效）。
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;

    dispatch({ type: 'load-start', requestId });

    try {
      const stats = await fetchAdminDocumentDatabaseStats();
      dispatch({ type: 'load-ready', requestId, stats });
    } catch (error) {
      dispatch({
        type: 'load-failed',
        requestId,
        message: isGraphQLIngressError(error)
          ? error.userMessage
          : '统计数据加载失败，请稍后重试。',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { state, reload: load };
}
