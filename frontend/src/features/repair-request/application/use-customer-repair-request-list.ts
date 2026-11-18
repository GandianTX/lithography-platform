// src/features/repair-request/application/use-customer-repair-request-list.ts

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type { NotifyFeedback } from '@/shared/feedback';
import { isGraphQLIngressError } from '@/shared/graphql';
import { translateNow } from '@/shared/i18n';

import {
  deleteMyRepairRequest,
  fetchMyRepairRequests,
} from '../infrastructure/repair-request-adapter';
import type {
  RepairRequestListPage,
  RepairRequestListPagination,
} from '../infrastructure/repair-request-read.types';

/**
 * 客户「我的维修申请」列表流程（query + delete command，收束在 feature application）。
 *
 * - 加载中 / 已就绪 / 失败（含重试）三态齐全，页面只消费干净 view state；
 * - 请求序号随状态原子更新：翻页、重试或删除后回刷时，旧请求晚到不会覆盖当前结果；
 * - 删除命令：进行中防连点（ref 锁），回刷服从**最新分页意图**（见下「游标代际」），
 *   成功后按删除后的 total 计算回退页避免停留在空页，
 *   失败（业务拒绝或 transport）给明确反馈并刷新数据态，不做乐观成功；
 *   返回 boolean 供调用方编排导航（true 表示删除成功；并发拦下可返回 false）；
 * - 错误归一（GraphQLIngressError 用户文案 / 兜底文案）与分页回退参数都在本层，
 *   页面不再感知 adapter、分页游标与竞态细节；
 * - 反馈经注入的窄 port（NotifyFeedback）上报，由 ui 层决定呈现方式——本层不得依赖
 *   具体 UI 组件实现（docs/stable-clean/architecture.md 最小落地规则第 6 条）；
 * - auth 错误不在这里重复处理，仍由共享 GraphQL + auth-session 全局链路负责。
 */

// 列表每页条数：正式产品默认值（评审演示的分页需求不写入生产代码，review 裁定）。
const PAGE_SIZE = 10;

type CustomerRepairRequestListMachine =
  | { status: 'loading'; requestSeq: number }
  | { status: 'ready'; requestSeq: number; data: RepairRequestListPage }
  | { status: 'failed'; requestSeq: number; message: string };

/** 页面消费的干净 view state（不带内部请求序号） */
export type CustomerRepairRequestListView =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; data: RepairRequestListPage };

type CustomerRepairRequestListAction =
  | { type: 'load-start'; requestSeq: number }
  | { type: 'load-ready'; requestSeq: number; data: RepairRequestListPage }
  | { type: 'load-failed'; requestSeq: number; message: string };

function toUserMessage(error: unknown): string {
  return isGraphQLIngressError(error) ? error.userMessage : translateNow('repairList.loadFailed');
}

/** 删除后当前页可能删空：回退一页避免停留在空页 */
function resolvePageAfterDelete(page: number, pageSize: number, total: number): number {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  return Math.min(page, lastPage);
}

function customerRepairRequestListReducer(
  state: CustomerRepairRequestListMachine,
  action: CustomerRepairRequestListAction,
): CustomerRepairRequestListMachine {
  switch (action.type) {
    case 'load-start':
      // 开始新请求：原子切换到 loading 并记录序号，旧结果不再可能被应用
      return { status: 'loading', requestSeq: action.requestSeq };
    case 'load-ready':
      // 竞态防护：过期请求的结果直接丢弃
      if (action.requestSeq !== state.requestSeq) {
        return state;
      }

      return { status: 'ready', requestSeq: action.requestSeq, data: action.data };
    case 'load-failed':
      if (action.requestSeq !== state.requestSeq) {
        return state;
      }

      return { status: 'failed', requestSeq: action.requestSeq, message: action.message };
  }
}

function toViewState(machine: CustomerRepairRequestListMachine): CustomerRepairRequestListView {
  switch (machine.status) {
    case 'loading':
      return { status: 'loading' };
    case 'ready':
      return { status: 'ready', data: machine.data };
    case 'failed':
      return { status: 'failed', message: machine.message };
  }
}

export function useCustomerRepairRequestList(notify: NotifyFeedback, pageSize = PAGE_SIZE) {
  const [machine, dispatch] = useReducer(customerRepairRequestListReducer, {
    status: 'loading',
    requestSeq: 0,
  });
  const requestSeqRef = useRef(0);
  const cursorRef = useRef<RepairRequestListPagination>({ page: 1, pageSize });
  /**
   * 分页意图代际：游标**真的变化**时推进一次。
   *
   * 删除在途期间页面只禁用删除按钮、不禁用分页，用户仍可翻页；删除回调若直接用
   * 发起时捕获的旧游标回刷，就会把用户从已选择的页拉回旧页。回刷因此以代际判定
   * 「用户是否已离开删除发起时的页」，而不是假定游标没变。
   */
  const cursorGenerationRef = useRef(0);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const deletingRef = useRef(false);

  const loadList = useCallback(async (target: RepairRequestListPagination) => {
    requestSeqRef.current += 1;
    const requestSeq = requestSeqRef.current;

    if (target.page !== cursorRef.current.page || target.pageSize !== cursorRef.current.pageSize) {
      cursorGenerationRef.current += 1;
    }

    cursorRef.current = target;
    dispatch({ type: 'load-start', requestSeq });

    try {
      const data = await fetchMyRepairRequests(target);

      dispatch({ type: 'load-ready', requestSeq, data });
    } catch (error) {
      dispatch({ type: 'load-failed', requestSeq, message: toUserMessage(error) });
    }
  }, []);

  // 初次加载：以游标（第 1 页）发起
  useEffect(() => {
    void loadList(cursorRef.current);
  }, [loadList]);

  const retry = useCallback(() => {
    void loadList(cursorRef.current);
  }, [loadList]);

  const goToPage = useCallback(
    (page: number, nextPageSize: number) => {
      void loadList({ page, pageSize: nextPageSize });
    },
    [loadList],
  );

  /**
   * 发起删除。返回 true 表示删除成功（调用方可据此编排导航）；
   * 防连点锁拦截重复发起或删除失败时返回 false。
   */
  const deleteRequest = useCallback(
    async (id: number): Promise<boolean> => {
      if (deletingRef.current) {
        return false;
      }

      deletingRef.current = true;
      setDeletingId(id);

      // 捕获删除发起时的分页意图（游标 + 代际）：删除在途期间用户仍可能翻页
      const cursorAtDeleteStart = cursorRef.current;
      const generationAtDeleteStart = cursorGenerationRef.current;

      let deleteSucceeded = false;

      try {
        const result = await deleteMyRepairRequest(id);

        deleteSucceeded = result.ok;

        if (result.ok) {
          notify({ type: 'success', text: translateNow('customer.requestDeleted') });
        } else {
          // 删除失败必须给出明确原因（不得当作删除成功）
          notify({ type: 'error', text: result.message });
        }
      } catch (error) {
        notify({
          type: 'error',
          text: isGraphQLIngressError(error)
            ? error.userMessage
            : translateNow('customer.deleteFailed'),
        });
      } finally {
        // 回刷时序：成功 / 业务拒绝 / transport 异常共用同一规则。
        // - 游标代际已变（用户在删除在途时翻页）→ 刷新**最新**游标，绝不回载捕获的旧游标；
        // - 代际未变且删除成功 → 按删除后的 total 计算回退页，避免停留在被删空的末页；
        // - 其余（删除失败，或非 ready 兜底）→ 刷新发起删除时的页，不做乐观成功。
        if (cursorGenerationRef.current !== generationAtDeleteStart) {
          await loadList(cursorRef.current);
        } else if (deleteSucceeded && machine.status === 'ready') {
          await loadList({
            page: resolvePageAfterDelete(
              machine.data.page,
              cursorAtDeleteStart.pageSize,
              machine.data.total - 1,
            ),
            pageSize: cursorAtDeleteStart.pageSize,
          });
        } else {
          await loadList(cursorAtDeleteStart);
        }

        deletingRef.current = false;
        setDeletingId(null);
      }

      return deleteSucceeded;
    },
    [machine, loadList, notify],
  );

  return {
    state: toViewState(machine),
    deletingId,
    deleteRequest,
    goToPage,
    retry,
  };
}
