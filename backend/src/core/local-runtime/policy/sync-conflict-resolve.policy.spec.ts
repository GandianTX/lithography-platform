// src/core/local-runtime/policy/sync-conflict-resolve.policy.spec.ts

import { SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import {
  resolveSyncConflictOutcome,
  type SyncConflictDecisionFacts,
} from './sync-conflict-resolve.policy';

/**
 * 裁决规则的三条红线（R067–R069）：
 * 1. 已裁决的冲突换方向必须显式拒绝（不静默覆盖既有确认）；
 * 2. 重复相同方向返回既有事实（不生成第二个修订）；
 * 3. 稍后处理保持待处理且不写确认人。
 */
/** DomainError 的 code 不进 message：统一用 try/catch 断言错误码 */
function expectPolicyError(action: () => void, code: string): void {
  expect(action).toThrow(DomainError);
  try {
    action();
  } catch (error) {
    expect((error as DomainError).code).toBe(code);
  }
}

describe('sync conflict resolve policy', () => {
  const pending: SyncConflictDecisionFacts = { status: 'PENDING', decision: null };
  const pendingTouched: SyncConflictDecisionFacts = { status: 'PENDING', decision: 'PENDING' };

  it('待处理冲突：使用云端 → 需要写入 CLOUD', () => {
    expect(resolveSyncConflictOutcome(pending, 'CLOUD')).toEqual({
      kind: 'write',
      action: 'CLOUD',
      decision: 'CLOUD',
    });
  });

  it('待处理冲突：稍后处理 → 保持待处理，不写入', () => {
    expect(resolveSyncConflictOutcome(pending, 'LATER')).toEqual({ kind: 'later' });
    expect(resolveSyncConflictOutcome(pendingTouched, 'LATER')).toEqual({ kind: 'later' });
  });

  it('待处理冲突：保留本地在受控写入入口（X04）接入前显式失败', () => {
    expectPolicyError(
      () => resolveSyncConflictOutcome(pending, 'LOCAL'),
      SYNC_ERROR.LOCAL_RESOLUTION_NOT_AVAILABLE,
    );
  });

  it('已按云端裁决：重复使用云端返回既有事实，不重复写', () => {
    expect(resolveSyncConflictOutcome({ status: 'RESOLVED', decision: 'CLOUD' }, 'CLOUD')).toEqual({
      kind: 'existing',
    });
  });

  it('已按本地裁决：重复保留本地返回既有事实', () => {
    expect(resolveSyncConflictOutcome({ status: 'RESOLVED', decision: 'LOCAL' }, 'LOCAL')).toEqual({
      kind: 'existing',
    });
  });

  it('已裁决冲突：换方向显式拒绝，不覆盖既有确认', () => {
    expectPolicyError(
      () => resolveSyncConflictOutcome({ status: 'RESOLVED', decision: 'CLOUD' }, 'LOCAL'),
      SYNC_ERROR.CONFLICT_ALREADY_RESOLVED,
    );
    expectPolicyError(
      () => resolveSyncConflictOutcome({ status: 'RESOLVED', decision: 'LOCAL' }, 'CLOUD'),
      SYNC_ERROR.CONFLICT_ALREADY_RESOLVED,
    );
  });

  it('已裁决冲突：稍后处理没有意义，返回既有事实', () => {
    expect(resolveSyncConflictOutcome({ status: 'RESOLVED', decision: 'CLOUD' }, 'LATER')).toEqual({
      kind: 'existing',
    });
    expect(resolveSyncConflictOutcome({ status: 'IGNORED', decision: null }, 'LATER')).toEqual({
      kind: 'existing',
    });
  });
});
