// src/features/repair-request/application/use-engineer-repair-workbench.ts

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';
import { translateNow } from '@/shared/i18n';

import type { EngineerRepairRequestListItem } from '../infrastructure/engineer-repair-request.types';
import { fetchEngineerRepairRequests } from '../infrastructure/engineer-repair-request-adapter';

import { onEngineerRepairListsInvalidated } from './engineer-repair-list-refresh';

/**
 * 工程师首页工作台流程（query 编排，收束在 feature application）。
 *
 * - 左侧「最近待接单」与页头「待接单 / 我的接单」统计复用 P1 列表读协议（同一 adapter），
 *   不建第二套读接口、不使用固定数组或前端猜测的统计；
 * - 最近待接单：AVAILABLE 范围第 1 页前 N 条（完整列表与分页在列表路由），
 *   待接单总数取同一次 AVAILABLE 查询返回的 total（不是首页最多 N 条的条目数）；
 *   我的已接单数量：MINE 范围查询返回的 total（pageSize 取 1 只为取 total）；
 * - 请求序号守卫：重试或失效刷新后，旧请求返回不会覆盖当前结果；
 * - 订阅列表失效通道：接单流程变化后，挂载中的工作台按当前口径重新取真实数据；
 * - 选中摘要取自最近待接单列表项本身（列表项已含全部展示字段），
 *   不再发起第二份详情查询；刷新后选中项消失时回落到首条，不保留过期引用；
 * - auth 错误不在这里特殊处理，仍由共享 GraphQL + auth-session 全局链路负责。
 */

/** 最近待接单展示条数（首页只做「最近」预览，不承载完整分页） */
export const ENGINEER_WORKBENCH_RECENT_SIZE = 6;

export type EngineerRepairWorkbenchState =
  | { status: 'loading'; requestSeq: number }
  | {
      status: 'ready';
      requestSeq: number;
      recentItems: EngineerRepairRequestListItem[];
      availableTotal: number;
      mineTotal: number;
    }
  | { status: 'failed'; requestSeq: number; message: string };

type WorkbenchAction =
  | { type: 'load-start'; requestId: number }
  | {
      type: 'load-ready';
      requestId: number;
      recentItems: EngineerRepairRequestListItem[];
      availableTotal: number;
      mineTotal: number;
    }
  | { type: 'load-failed'; requestId: number; message: string };

function workbenchReducer(state: EngineerRepairWorkbenchState, action: WorkbenchAction) {
  switch (action.type) {
    case 'load-start':
      return { status: 'loading' as const, requestSeq: action.requestId };
    case 'load-ready':
      if (action.requestId !== state.requestSeq) {
        return state;
      }
      return {
        status: 'ready' as const,
        requestSeq: action.requestId,
        recentItems: action.recentItems,
        availableTotal: action.availableTotal,
        mineTotal: action.mineTotal,
      };
    case 'load-failed':
      if (action.requestId !== state.requestSeq) {
        return state;
      }
      return { status: 'failed' as const, requestSeq: action.requestId, message: action.message };
  }
}

function toWorkbenchUserMessage(error: unknown): string {
  return isGraphQLIngressError(error) ? error.userMessage : translateNow('workbench.loadFailed');
}

const NO_FILTER = { equipmentModelId: null, customerNickname: null };

export function useEngineerRepairWorkbench() {
  const [state, dispatch] = useReducer(workbenchReducer, {
    status: 'loading' as const,
    requestSeq: 0,
  });
  const requestIdRef = useRef(0);
  // 选中申请：仅保存 ID 真源，摘要数据从最新列表项派生，不复制第二份
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const loadWorkbench = useCallback(async () => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    dispatch({ type: 'load-start', requestId });

    try {
      // 两个范围同一读协议并行查询；任一失败则整体进入失败态（可重试），不展示半真半假的数据
      const [recent, mine] = await Promise.all([
        fetchEngineerRepairRequests({
          scope: 'AVAILABLE',
          filter: NO_FILTER,
          page: 1,
          pageSize: ENGINEER_WORKBENCH_RECENT_SIZE,
        }),
        fetchEngineerRepairRequests({
          scope: 'MINE',
          filter: NO_FILTER,
          page: 1,
          pageSize: 1,
        }),
      ]);

      dispatch({
        type: 'load-ready',
        requestId,
        recentItems: recent.items,
        availableTotal: recent.total,
        mineTotal: mine.total,
      });
    } catch (error) {
      dispatch({ type: 'load-failed', requestId, message: toWorkbenchUserMessage(error) });
    }
  }, []);

  useEffect(() => {
    void loadWorkbench();
  }, [loadWorkbench]);

  // 接单成功 / 冲突后宣告失效：工作台重新取真实数据，不保留过期统计
  useEffect(
    () =>
      onEngineerRepairListsInvalidated(() => {
        void loadWorkbench();
      }),
    [loadWorkbench],
  );

  /**
   * 选中项：优先用户选择的 ID；该 ID 不在最新列表中（已被接走/消失）时
   * 回落首条，避免保留过期引用；列表为空时无选中。
   */
  const selectedItem =
    state.status === 'ready'
      ? (state.recentItems.find((item) => item.id === selectedId) ?? state.recentItems[0] ?? null)
      : null;

  return {
    state,
    selectedItem,
    select: setSelectedId,
    reload: loadWorkbench,
  };
}
