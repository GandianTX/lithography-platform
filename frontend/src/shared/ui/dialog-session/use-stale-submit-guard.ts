// src/shared/ui/dialog-session/use-stale-submit-guard.ts

/**
 * 弹窗提交代次守卫：管理端多个写弹窗共用的唯一实现。
 *
 * 为什么需要它：弹窗的会话可以在提交续体回来之前被推进——关闭、重新打开、切换目标行都算。
 * 而弹窗组件在宿主里恒定挂载、只切换 `open` / `row`，`destroyOnHidden` 只销毁 Modal 子树（Form），
 * 不会重置弹窗自己的 `useState`。于是旧续体晚到时会造成两类可见故障：
 *
 * - 上一个目标的失败信息被写进已经切换到的新目标弹窗；
 * - 失败信息写进已关闭的弹窗并滞留，下次打开任意目标时凭空出现陈旧错误。
 *
 * 关于「提交期间能不能关闭弹窗」的准确边界：antd 6.4.3 的 `Modal.handleCancel` 在
 * `confirmLoading` 为真时直接 `return`，取消按钮、右上角 X、遮罩点击与 Esc 四条关闭路径共用它；
 * 宿主又把 `confirmLoading` 接到了命令 hook 的 `isPending(key)`，因此**在当前宿主接线下**
 * 用户没有可达路径在提交期间关闭弹窗。但 `submitting` 是调用方传进来的 prop，不是弹窗自己的事实：
 * 宿主传 `submitting={false}`、把 `confirmLoading` 改接别的信号、或日后加上自动关闭入口，
 * 四条路径立刻全部生效。守卫的正确性因此刻意不依赖宿主的 loading 接线。
 *
 * 守卫方式与本仓列表读路径一致（如 `use-admin-user-list.ts` 用 `requestSeq` 丢弃过期结果）：
 * 用单调递增的代次标记每一次弹窗会话，续体回来时代次不一致即整体丢弃。
 *
 * 代次推进时机（缺一不可，两处都在事件处理器 / commit 内，不在 render 里碰 ref）：
 * - 关闭弹窗：由 Modal 的 `onCancel` 在事件处理器里**同步**调用 `invalidateInFlightSubmit()`；
 * - 重新打开、切换目标行：`targetKey` 变化时由 `useLayoutEffect` 推进。
 *
 * 为什么拆成两处、而不是全部放在 render 阶段：代次存在 ref 里，而本仓 ESLint 的
 * `react-hooks/refs` 禁止在 render 期间读写 ref。这不是风格洁癖：render 可能被并发特性重放或
 * 丢弃，在 render 里 `+= 1` 不幂等。而 `react-hooks/set-state-in-effect` 又禁止在 effect 里
 * 直接 setState，因此「清空上一代错误」留在 render 阶段走 React 官方的「按 props 调整 state」
 * 范式，代次自增单独交给 layout effect，两者各守一条规则。
 *
 * 为什么是 `useLayoutEffect` 而不是 `useEffect`：前者在 commit 内同步执行、早于浏览器绘制，
 * 也早于任何可能插入的微任务，因此「props 变更已提交」与「代次已推进」之间没有事件循环窗口。
 * passive effect 由调度器另行执行，确实会留出窗口，在途提交的续体可能恰好落在窗口内，
 * 拿着仍然相等的代次把上一会话的结果写进新会话，所以本守卫不能用它。
 *
 * 关闭后重开同一个目标会经历 `key → null → key` 两次推进，因此必然属于新代次，
 * 旧续体不可能冒充新会话。
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** 会话身份：行级弹窗传目标主键，创建弹窗没有目标，传 `open` 的每一次翻转 */
export type StaleSubmitGuardTargetKey = boolean | number | string | null;

export type StaleSubmitGuard = {
  /** 提交开始时调用，返回本次提交的代次快照，需在 `await` 之后交回 `isCurrentSubmitSeq` 核对 */
  captureSubmitSeq: () => number;
  /**
   * 代次是否仍属于本次提交。返回 false 表示提交期间弹窗已被关闭 / 重开 / 切换目标，
   * 本次结果必须整体丢弃：既不写入错误区，也不清除新会话已有的错误。
   */
  isCurrentSubmitSeq: (submitSeq: number) => boolean;
  /** 推进代次并清空弹窗内错误提示；关闭、重开、切换目标都调用它 */
  invalidateInFlightSubmit: () => void;
  setSubmitError: (message: string | null) => void;
  submitError: string | null;
};

export function useStaleSubmitGuard(targetKey: StaleSubmitGuardTargetKey): StaleSubmitGuard {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [renderedTargetKey, setRenderedTargetKey] = useState(targetKey);
  const submitSeqRef = useRef(0);

  /**
   * React 官方的「按 props 调整 state」范式：render 期间只更新**本组件自己的** state，
   * React 会丢弃本次输出并立即重渲染，因此新目标不会闪现上一代的错误。
   * 这里刻意不碰 ref：代次自增不幂等，render 被重放时会多推，改由下面的 layout effect 承担。
   */
  if (renderedTargetKey !== targetKey) {
    setRenderedTargetKey(targetKey);
    setSubmitError(null);
  }

  // 挂载时也会执行一次（代次 0 → 1）：此时不存在在途提交，多推进一次的方向是
  // 「更保守地丢弃」，不会把陈旧结果误判为新会话；换来的是不必再维护一个「是否首次」旁路标记。
  // effect 内只写 ref、不 setState，避开 `react-hooks/set-state-in-effect`。
  useLayoutEffect(() => {
    submitSeqRef.current += 1;
  }, [targetKey]);

  const invalidateInFlightSubmit = useCallback(() => {
    submitSeqRef.current += 1;
    setSubmitError(null);
  }, []);

  const captureSubmitSeq = useCallback(() => submitSeqRef.current, []);

  const isCurrentSubmitSeq = useCallback(
    (submitSeq: number) => submitSeq === submitSeqRef.current,
    [],
  );

  return {
    captureSubmitSeq,
    invalidateInFlightSubmit,
    isCurrentSubmitSeq,
    setSubmitError,
    submitError,
  };
}
