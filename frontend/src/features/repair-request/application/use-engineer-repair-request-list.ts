// src/features/repair-request/application/use-engineer-repair-request-list.ts

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';
import { translateNow } from '@/shared/i18n';

import type {
  EngineerRepairListFilter,
  EngineerRepairListScope,
  EngineerRepairRequestListItem,
} from '../infrastructure/engineer-repair-request.types';
import { fetchEngineerRepairRequests } from '../infrastructure/engineer-repair-request-adapter';

import { onEngineerRepairListsInvalidated } from './engineer-repair-list-refresh';

/**
 * 工程师维修申请列表流程（use case / query 状态机，收束在 feature application）。
 *
 * - 查询参数（scope / filter / page）由本状态机统一持有，UI 只发意图：
 *   scope 默认 ALL（后端缺省值一致），切换 scope 或筛选都回到第 1 页，
 *   翻页沿用当前 scope 与筛选；
 * - scope 与 GraphQL 参数严格使用后端 ALL / AVAILABLE / MINE / TAKEN_BY_OTHER，
 *   不创建第三套前端状态值；
 * - 筛选值原样传给后端（设备型号 ID 等值、客户昵称关键词），
 *   不在前端对当前页做二次假过滤；昵称空白归一由 UI 输入层收敛为 null；
 * - 加载中 / 空结果 / 失败（含重试）/ 分页齐全；
 * - 请求序号随状态原子更新：切换范围、筛选、翻页或重试后，旧请求返回不会覆盖当前结果；
 * - 订阅接单流程的列表失效通道，接单成功或冲突后自动按当前参数刷新；
 * - auth 错误不在这里特殊处理，仍由共享 GraphQL + auth-session 全局链路负责。
 */

/** 列表查询参数（状态机光标，随 load-start 原子进入 state 供渲染读取） */
export type EngineerRepairListCursor = {
  scope: EngineerRepairListScope;
  page: number;
  filter: EngineerRepairListFilter;
};

export type EngineerRepairListState =
  | { status: 'loading'; requestSeq: number; cursor: EngineerRepairListCursor }
  | {
      status: 'ready';
      requestSeq: number;
      cursor: EngineerRepairListCursor;
      items: EngineerRepairRequestListItem[];
      total: number;
      page: number;
      pageSize: number;
    }
  | { status: 'failed'; requestSeq: number; cursor: EngineerRepairListCursor; message: string };

type EngineerRepairListAction =
  | { type: 'load-start'; requestId: number; cursor: EngineerRepairListCursor }
  | {
      type: 'load-ready';
      requestId: number;
      items: EngineerRepairRequestListItem[];
      total: number;
      page: number;
      pageSize: number;
    }
  | { type: 'load-failed'; requestId: number; message: string };

function toListUserMessage(error: unknown): string {
  return isGraphQLIngressError(error) ? error.userMessage : translateNow('repairList.loadFailed');
}

function engineerRepairListReducer(
  state: EngineerRepairListState,
  action: EngineerRepairListAction,
): EngineerRepairListState {
  switch (action.type) {
    case 'load-start':
      // 开始新请求：原子切换到 loading 并记录序号与光标，旧结果不再可能被应用
      return { status: 'loading', requestSeq: action.requestId, cursor: action.cursor };
    case 'load-ready':
      // 竞态防护：过期请求的结果直接丢弃
      if (action.requestId !== state.requestSeq) {
        return state;
      }
      return {
        status: 'ready',
        requestSeq: action.requestId,
        cursor: state.cursor,
        items: action.items,
        total: action.total,
        page: action.page,
        pageSize: action.pageSize,
      };
    case 'load-failed':
      if (action.requestId !== state.requestSeq) {
        return state;
      }
      return {
        status: 'failed',
        requestSeq: action.requestId,
        cursor: state.cursor,
        message: action.message,
      };
  }
}

const NO_FILTER: EngineerRepairListFilter = { equipmentModelId: null, customerNickname: null };

export function useEngineerRepairRequestList(
  initialScope: EngineerRepairListScope = 'ALL',
  pageSize = 10,
) {
  const [state, dispatch] = useReducer(engineerRepairListReducer, {
    status: 'loading',
    requestSeq: 0,
    cursor: { scope: initialScope, page: 1, filter: NO_FILTER },
  } as EngineerRepairListState);
  const requestIdRef = useRef(0);
  // 事件回调与失效刷新需要「最新光标」：ref 只在事件期读取，渲染一律读 state.cursor
  const cursorRef = useRef<EngineerRepairListCursor>(state.cursor);

  const loadList = useCallback(
    async (cursor: EngineerRepairListCursor) => {
      requestIdRef.current += 1;
      const requestId = requestIdRef.current;
      cursorRef.current = cursor;
      dispatch({ type: 'load-start', requestId, cursor });

      try {
        const result = await fetchEngineerRepairRequests({
          scope: cursor.scope,
          filter: cursor.filter,
          page: cursor.page,
          pageSize,
        });
        dispatch({
          type: 'load-ready',
          requestId,
          items: result.items,
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
        });
      } catch (error) {
        dispatch({ type: 'load-failed', requestId, message: toListUserMessage(error) });
      }
    },
    [pageSize],
  );

  // 初次加载：按初始范围（缺省 ALL）第 1 页无筛选加载
  useEffect(() => {
    void loadList({ scope: initialScope, page: 1, filter: NO_FILTER });
  }, [initialScope, loadList]);

  // 接单成功 / 冲突后由接单流程宣告失效，挂载中的列表按当前参数刷新
  useEffect(
    () =>
      onEngineerRepairListsInvalidated(() => {
        void loadList(cursorRef.current);
      }),
    [loadList],
  );

  /** 切换范围：回到第 1 页，保留已设置的筛选 */
  const setScope = useCallback(
    (scope: EngineerRepairListScope) => {
      const cursor = cursorRef.current;
      if (cursor.scope === scope) {
        return;
      }
      void loadList({ ...cursor, scope, page: 1 });
    },
    [loadList],
  );

  /** 更新筛选：回到第 1 页（入参由 UI 输入层归一，这里不二次清洗） */
  const setFilter = useCallback(
    (filter: EngineerRepairListFilter) => {
      const cursor = cursorRef.current;
      if (
        cursor.filter.equipmentModelId === filter.equipmentModelId &&
        cursor.filter.customerNickname === filter.customerNickname
      ) {
        return;
      }
      void loadList({ ...cursor, filter, page: 1 });
    },
    [loadList],
  );

  const goToPage = useCallback(
    (page: number) => {
      void loadList({ ...cursorRef.current, page });
    },
    [loadList],
  );

  const reload = useCallback(() => {
    void loadList(cursorRef.current);
  }, [loadList]);

  return {
    state,
    scope: state.cursor.scope,
    filter: state.cursor.filter,
    setScope,
    setFilter,
    goToPage,
    reload,
  };
}
