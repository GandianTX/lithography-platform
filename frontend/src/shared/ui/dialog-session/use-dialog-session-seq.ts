// src/shared/ui/dialog-session/use-dialog-session-seq.ts

/**
 * 宿主侧弹窗会话代次守卫（双层守卫的外层）。
 *
 * 弹窗侧的 `use-stale-submit-guard` 只能保护弹窗**自己的**本地状态（错误区）。
 * 「关闭弹窗」这个动作的归属在宿主：`setProfileRow(null)` 之类的收尾一旦认错会话，
 * 就会出现 A 的成功关掉 B、或者关掉「关闭后重新打开的同一个 A」——数据库写入是真的，
 * 但被关掉的是另一代会话的弹窗，用户正在填的内容随之丢失。
 *
 * 因此宿主为每个弹窗各维护一条会话代次：
 * - 打开 / 关闭 / 切换目标都在事件处理器里**同步**推进，不依赖 effect，
 *   否则「关闭」与「立刻重开」落在同一个事件循环窗口内时代次不会变化；
 * - 提交入口捕获本次会话代次与目标标识；
 * - 成功续体回来后先比对代次，再在函数式 state updater 里对**最新**目标复核标识。
 *
 * 只比对目标标识是不够的：关闭 A 再重新打开同一个 A，标识完全相同，
 * 旧请求的成功续体照样会把新一代 A 弹窗关掉。代次是区分「同一目标的第几代会话」的唯一手段。
 *
 * 边界说明：antd 6.4.3 的 `Modal.handleCancel` 在 `confirmLoading` 为真时直接 `return`，
 * 取消按钮 / X / 遮罩 / Esc 四条关闭路径共用它，而宿主通常把 `confirmLoading` 接到了
 * 命令 hook 的 `isPending(key)`。因此当前接线下用户在提交期间关不掉弹窗，
 * 本守卫面向的是「提交期间切换目标」与「宿主接线一旦放松后的关闭 / 重开」；
 * 它不依赖 antd 的这个门禁，也不因它而多余。
 *
 * 代次存放在 ref 而非 state：它是判定用的旁路事实，不参与渲染，
 * 放进 state 只会让每次开关弹窗多一轮无意义的重渲染。
 */

import { useCallback, useRef } from 'react';

export type DialogSessionSeqGuard<K extends string> = {
  /** 推进指定弹窗的会话代次：打开、关闭、切换目标都必须调用 */
  advance: (key: K) => void;
  /** 提交开始时调用，返回该弹窗当前会话代次快照 */
  capture: (key: K) => number;
  /** 代次是否仍属于本次提交；false ⇒ 提交期间该弹窗已被关闭 / 重开 / 切换目标 */
  isCurrent: (key: K, sessionSeq: number) => boolean;
};

export function useDialogSessionSeq<K extends string>(): DialogSessionSeqGuard<K> {
  const seqRef = useRef(new Map<K, number>());

  const advance = useCallback((key: K) => {
    seqRef.current.set(key, (seqRef.current.get(key) ?? 0) + 1);
  }, []);

  const capture = useCallback((key: K) => seqRef.current.get(key) ?? 0, []);

  const isCurrent = useCallback(
    (key: K, sessionSeq: number) => (seqRef.current.get(key) ?? 0) === sessionSeq,
    [],
  );

  return { advance, capture, isCurrent };
}
