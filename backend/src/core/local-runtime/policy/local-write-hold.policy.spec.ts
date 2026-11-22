// src/core/local-runtime/policy/local-write-hold.policy.spec.ts

/**
 * 写入／同步冻结裁决的定向测试（任务 09 S5-2）。
 *
 * 守住三条：① 冻结按**公司数据区**判定（其它公司不受影响）；
 * ② 只认 ACTIVE 冻结（已解除的不再拦）；③ 判定是纯函数、无 I/O。
 */

import {
  decideLocalWriteHoldVerdict,
  LOCAL_WRITE_HOLD_REASON_CODES,
  LOCAL_WRITE_HOLD_TYPES,
  type LocalWriteHoldFact,
} from './local-write-hold.policy';

function hold(overrides: Partial<LocalWriteHoldFact> = {}): LocalWriteHoldFact {
  return {
    organizationId: 4,
    holdType: LOCAL_WRITE_HOLD_TYPES.RESTORE,
    status: 'ACTIVE',
    reason: '恢复期冻结',
    ...overrides,
  };
}

describe('写入/同步冻结裁决（S5-2）', () => {
  it('无冻结 → 放行', () => {
    const verdict = decideLocalWriteHoldVerdict({ organizationId: 4, holds: [] });

    expect(verdict.allowed).toBe(true);
  });

  it('目标公司处于 ACTIVE 冻结 → 拒绝并给出受控原因码', () => {
    const verdict = decideLocalWriteHoldVerdict({
      organizationId: 4,
      holds: [hold()],
    });

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) {
      throw new Error('不应放行');
    }
    expect(verdict.reasonCode).toBe(LOCAL_WRITE_HOLD_REASON_CODES.WRITE_HELD_FOR_RESTORE);
    expect(verdict.reason).toContain('恢复期冻结');
  });

  it('冻结的是别的公司 → 本公司放行（不做全设备一刀切）', () => {
    const verdict = decideLocalWriteHoldVerdict({
      organizationId: 4,
      holds: [hold({ organizationId: 5 })],
    });

    expect(verdict.allowed).toBe(true);
  });

  it('已解除（RELEASED）的冻结不再拦截', () => {
    const verdict = decideLocalWriteHoldVerdict({
      organizationId: 4,
      holds: [hold({ status: 'RELEASED' })],
    });

    expect(verdict.allowed).toBe(true);
  });
});
