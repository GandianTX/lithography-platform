// src/features/repair-request/application/use-customer-repair-request-detail-flow.ts

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { NotifyFeedback } from '@/shared/feedback';
import { isGraphQLIngressError } from '@/shared/graphql';
import { translateNow } from '@/shared/i18n';

import {
  deleteMyRepairRequest,
  fetchMyRepairRequest,
} from '../infrastructure/repair-request-adapter';
import type { RepairRequestDetail } from '../infrastructure/repair-request-read.types';

/**
 * 客户维修申请详情流程（load query + delete command 编排，收束在 feature application）。
 *
 * - requestId 由路由层从 useParams 注入；不存在 / 非本人 / 已删除由后端统一 NOT_FOUND
 *   （防探测），归并为 notFound 态而非数据；
 * - 加载代次：只有最新一次请求可以把结果写入状态，切换 requestId 后前一个请求晚到
 *   不得覆盖当前详情（无旧内容残留）；卸载 / 切走都作废本次代次；
 * - 状态自带 requestId：渲染时若与当前 requestId 不一致即视为 loading，
 *   避免切换申请后在新数据到达前继续展示上一份申请；
 * - 删除命令绑定发起时的「目标代次」：await 之后代次不一致（requestId 已切换或组件已卸载）
 *   即整体丢弃结果，不提示、不回刷、不返回成功；在途锁按代次记录，finally 只释放自身代次，
 *   跨目标不串锁；删除 pending 按钮态与「目标 + 代次」绑定并以纯派生呈现（render 期间
 *   无 setState；2026-10-02 复审移除了 deleteSessionId 的 render-phase 复位）；
 *   失败（业务拒绝或 transport）给明确反馈并回刷详情，不做乐观成功；
 * - deleteRequest 返回 boolean：true 表示删除成功且目标仍有效，调用方（页面）据此导航回列表；
 * - 反馈经注入的窄 port（NotifyFeedback）上报，由 ui 层决定呈现方式——本层不得依赖
 *   具体 UI 组件实现（docs/stable-clean/architecture.md 最小落地规则第 6 条）；
 * - auth 错误不在这里重复处理，仍由共享 GraphQL + auth-session 全局链路负责。
 */

type CustomerRepairRequestDetailMachine =
  | { requestId: number; status: 'loading' }
  | { requestId: number; status: 'failed'; message: string; notFound: boolean }
  | { requestId: number; status: 'ready'; detail: RepairRequestDetail };

/** 页面消费的干净 view state（与当前 requestId 对齐，不带内部代次/目标字段） */
export type CustomerRepairRequestDetailState =
  | { status: 'loading' }
  | { status: 'failed'; message: string; notFound: boolean }
  | { status: 'ready'; detail: RepairRequestDetail };

function toViewState(
  machine: CustomerRepairRequestDetailMachine,
): CustomerRepairRequestDetailState {
  switch (machine.status) {
    case 'loading':
      return { status: 'loading' };
    case 'ready':
      return { status: 'ready', detail: machine.detail };
    case 'failed':
      return { status: 'failed', message: machine.message, notFound: machine.notFound };
  }
}

export function useCustomerRepairRequestDetailFlow(requestId: number, notify: NotifyFeedback) {
  const [machine, setMachine] = useState<CustomerRepairRequestDetailMachine>({
    requestId,
    status: 'loading',
  });
  // 删除在途的可见 pending 态与「发起它的目标 + 代次」绑定（不单独存布尔）：
  // 目标切换时可见态由渲染期纯派生（deletePending.requestId === requestId）自然退出，
  // 不再需要、也不允许在 render 期间 setState 复位。旧实现用 `deleteSessionId !== requestId`
  // 触发 setState，NaN 使比较恒真，会形成无限重渲染（2026-10-02 复审修复；
  // 非法 ID 现已在路由边界被拒绝，hook 保持「只接收已验证正整数」的窄契约）。
  const [deletePending, setDeletePending] = useState<{
    generation: number;
    requestId: number;
  } | null>(null);
  // 每次加载递增的代次令牌：只有最新一次请求可以把结果写入状态，
  // 否则切换 requestId 后前一个请求晚到，会覆盖当前详情。
  const loadGenerationRef = useRef(0);
  // 删除命令的代次：与加载代次解耦——加载代次会被「删除失败后的回刷」主动推进，
  // 用它判断「本次删除是否仍属当前目标」会把自身的失败回刷误判成目标已切换。
  const deleteGenerationRef = useRef(0);
  // 在途删除锁按代次记录（而非布尔）：同代次重复发起才拦；跨目标不串锁，
  // finally 也只释放归属自身代次的锁，旧代次的收尾不会误释放新目标的锁。
  const deletingGenerationRef = useRef<number | null>(null);

  // 代次由 layout effect 在 commit 内同步推进：react-hooks/refs 禁止 render 期间读写 ref，
  // 且 render 可能被并发特性重放而自增不幂等（本仓同口径见
  // reference-document-detail-panel 与 admin-user-management 的 use-stale-submit-guard）。
  // cleanup 在 route 参数变化与组件卸载时使本代次失效：在途删除只能静默收尾，
  // 不得提示 / 回刷，也不得把已进入其他页面的用户强制带回列表。
  useLayoutEffect(() => {
    deleteGenerationRef.current += 1;

    const generation = deleteGenerationRef.current;

    return () => {
      if (deleteGenerationRef.current === generation) {
        deleteGenerationRef.current += 1;
      }
    };
  }, [requestId]);

  const loadDetail = useCallback(async (id: number) => {
    loadGenerationRef.current += 1;
    const generation = loadGenerationRef.current;

    try {
      const result = await fetchMyRepairRequest(id);

      if (generation !== loadGenerationRef.current) {
        return; // 已有更新的请求发出：本次结果作废，不得覆盖
      }

      if (result.ok) {
        setMachine({ requestId: id, status: 'ready', detail: result.detail });
      } else {
        // 分类依据显式化：只有 not-found 呈现 warning 态，未来新增 failure reason 不会误分类
        setMachine({
          requestId: id,
          status: 'failed',
          message: result.message,
          notFound: result.reason === 'not-found',
        });
      }
    } catch (error) {
      if (generation !== loadGenerationRef.current) {
        return;
      }

      setMachine({
        requestId: id,
        status: 'failed',
        message: isGraphQLIngressError(error)
          ? error.userMessage
          : translateNow('customer.detailLoadFailed'),
        notFound: false,
      });
    }
  }, []);

  useEffect(() => {
    // 微任务中发起：effect 同步链路不触发 setState
    queueMicrotask(() => void loadDetail(requestId));

    return () => {
      // 切走或卸载即作废本次代次：在途响应到达也不得再写入状态
      loadGenerationRef.current += 1;
    };
  }, [loadDetail, requestId]);

  /**
   * 发起删除。返回：
   * - true：删除成功且目标仍有效，调用方应导航回列表；
   * - false：目标已在途中切换/卸载（结果整体丢弃），或删除失败（已提示并回刷）。
   */
  const deleteRequest = useCallback(async (): Promise<boolean> => {
    const generation = deleteGenerationRef.current;

    // 同代次（同一目标）的重复发起才拦；跨目标不串锁
    if (deletingGenerationRef.current === generation) {
      return false;
    }

    deletingGenerationRef.current = generation;
    setDeletePending({ generation, requestId });

    try {
      const result = await deleteMyRepairRequest(requestId);

      // 目标已切换或组件已卸载：删除结果整体丢弃——不提示、不回刷、不返回成功。
      // 尤其不得回刷：回刷会推进加载代次，使已在途的新目标详情请求过期，
      // 而新目标的 effect 不会再运行，页面会永久停在骨架态。
      if (deleteGenerationRef.current !== generation) {
        return false;
      }

      if (result.ok) {
        notify({ type: 'success', text: translateNow('customer.requestDeleted') });

        return true;
      }

      notify({ type: 'error', text: result.message });
      setMachine({ requestId, status: 'loading' });
      void loadDetail(requestId);

      return false;
    } catch (error) {
      if (deleteGenerationRef.current !== generation) {
        return false;
      }

      notify({
        type: 'error',
        text: isGraphQLIngressError(error)
          ? error.userMessage
          : translateNow('customer.deleteFailed'),
      });
      setMachine({ requestId, status: 'loading' });
      void loadDetail(requestId);

      return false;
    } finally {
      // 只释放归属自身代次的锁：旧代次的收尾不得解锁新目标在途的删除
      if (deletingGenerationRef.current === generation) {
        deletingGenerationRef.current = null;
      }

      // 可见 pending 态同样只清「自己那一笔」：按代次精确匹配，
      // 旧 finally 不得清掉新目标在途的 pending
      setDeletePending((current) =>
        current !== null && current.generation === generation ? null : current,
      );
    }
  }, [loadDetail, notify, requestId]);

  // 可见 pending 态绑在发起目标上：切换目标后同一帧即按新目标的可用状态渲染
  // （纯派生，无 render 期间 setState；旧目标的在途锁按代次记录，不命中新代次）
  const deleting = deletePending !== null && deletePending.requestId === requestId;

  // 状态与当前 requestId 不匹配（切换申请）→ 立即按 loading 渲染：
  // 不在新数据到达前展示上一份申请的编号、故障内容、回复与删除按钮。
  const state: CustomerRepairRequestDetailState =
    machine.requestId === requestId ? toViewState(machine) : { status: 'loading' };

  return { state, deleting, deleteRequest };
}
