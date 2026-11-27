// src/core/local-runtime/policy/local-write-hold.policy.spec.ts

/**
 * 写入／同步冻结裁决的定向测试（任务 09 S5-2）。
 *
 * 守住三条：① 冻结按**公司数据区**判定（其它公司不受影响）；
 * ② 只认 ACTIVE 冻结（已解除的不再拦）；③ 判定是纯函数、无 I/O。
 */

import {
  decideIncidentForceReleaseVerdict,
  decideLocalWriteHoldVerdict,
  decideRestoreScopeOccupancyVerdict,
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

describe('历史 ACTIVE 冻结冲突裁决（第 12 项 · 合成实库取证 S1/S3/S7）', () => {
  it('同范围并存多条 ACTIVE ⇒ 建立冻结失败关闭（不静默挑一条）', () => {
    const verdict = decideRestoreScopeOccupancyVerdict({
      existingRestoreId: 'restore-a',
      requestedRestoreId: 'restore-b',
      activeHoldCount: 2,
    });

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) {
      throw new Error('不应放行');
    }
    expect(verdict.reasonCode).toBe(
      LOCAL_WRITE_HOLD_REASON_CODES.WRITE_HELD_FOR_RESTORE_SCOPE_OCCUPIED,
    );
    expect(verdict.reason).toContain('历史冲突');
  });

  it('同范围并存多条 ACTIVE ⇒ 其它恢复不得并行占用', () => {
    const verdict = decideRestoreScopeOccupancyVerdict({
      existingRestoreId: 'restore-a',
      requestedRestoreId: 'restore-b',
      activeHoldCount: 1,
    });

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) {
      throw new Error('不应放行');
    }
    expect(verdict.reasonCode).toBe(
      LOCAL_WRITE_HOLD_REASON_CODES.WRITE_HELD_FOR_RESTORE_SCOPE_OCCUPIED,
    );
  });

  it('现场强制解冻：请求方持有冻结 ⇒ 放行（归属判定与行序无关）', () => {
    const verdict = decideIncidentForceReleaseVerdict({
      ownedHoldCount: 1,
      incidentRestoreId: 'restore-a',
    });

    expect(verdict.allowed).toBe(true);
  });

  it('现场强制解冻：请求方在该范围内没有冻结 ⇒ 失败关闭（不得按范围一刀切）', () => {
    const verdict = decideIncidentForceReleaseVerdict({
      ownedHoldCount: 0,
      incidentRestoreId: 'restore-z',
    });

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) {
      throw new Error('不应放行');
    }
    expect(verdict.reasonCode).toBe(LOCAL_WRITE_HOLD_REASON_CODES.RELEASE_NOT_PERMITTED_NOT_OWNER);
  });
});
