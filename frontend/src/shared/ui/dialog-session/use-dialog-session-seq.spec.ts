// src/shared/ui/dialog-session/use-dialog-session-seq.spec.ts

/**
 * 宿主侧会话代次守卫的同步性直测。
 *
 * 这一层是「A → B 切换后旧请求不得关闭 B」的唯一判定依据，而它成立的理由**不是**弹窗侧
 * `useLayoutEffect` 的时序假设，是一个更强的事实：`advance` 直接改 ref，宿主的
 * 调用顺序是「先 advance、再 setState」，所以代次在 React 开始渲染新目标之前就已推进完毕，
 * 「新目标已提交但代次尚未推进」这个窗口对外层根本不存在。
 *
 * 本 spec 把「advance 不依赖 render / effect」钉死：全程不 rerender、不 act、不 flush 任何
 * effect，advance 之后 isCurrent 必须立刻给出新答案。
 */

import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useDialogSessionSeq } from './use-dialog-session-seq';

type DialogKey = 'create' | 'profile';

function renderGuard() {
  return renderHook(() => useDialogSessionSeq<DialogKey>()).result;
}

describe('useDialogSessionSeq', () => {
  it('advance 同步生效：不重渲染、不 flush effect，提交前捕获的快照立刻过期', () => {
    const guard = renderGuard();

    const captured = guard.current.capture('profile');
    guard.current.advance('profile');

    expect(guard.current.isCurrent('profile', captured)).toBe(false);
  });

  it('代次单调：旧快照在后续推进中永远不会重新变成当前代次', () => {
    const guard = renderGuard();

    const first = guard.current.capture('profile');
    guard.current.advance('profile');
    const second = guard.current.capture('profile');
    guard.current.advance('profile');
    guard.current.advance('profile');
    const latest = guard.current.capture('profile');

    expect(latest).toBeGreaterThan(second);
    expect(second).toBeGreaterThan(first);
    expect(guard.current.isCurrent('profile', first)).toBe(false);
    expect(guard.current.isCurrent('profile', second)).toBe(false);
    expect(guard.current.isCurrent('profile', latest)).toBe(true);
  });

  it('多个弹窗各持一条代次：推进一个 key 不影响另一个', () => {
    const guard = renderGuard();

    const createSeq = guard.current.capture('create');
    const profileSeq = guard.current.capture('profile');
    guard.current.advance('profile');

    expect(guard.current.isCurrent('profile', profileSeq)).toBe(false);
    expect(guard.current.isCurrent('create', createSeq)).toBe(true);
  });

  it('会话身份未变时不推进：新鲜提交的快照必须仍然有效', () => {
    // 宿主对「同一个目标的重入」与「创建入口在弹窗已打开时的重入」刻意不推进代次，
    // 这里钉住不推进 ⇒ 快照仍有效，否则在途的正常提交会被误判成陈旧，成功后弹窗关不掉
    const guard = renderGuard();

    const captured = guard.current.capture('create');

    expect(captured).toBe(0);
    expect(guard.current.isCurrent('create', captured)).toBe(true);
  });
});
