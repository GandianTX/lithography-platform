// src/core/stored-file/policy/stored-file-retention.policy.spec.ts
/// <reference types="jest" />

/**
 * 暂存原件保留窗口与过期清理的定向测试（任务 09 P3-3 跨资源失败补偿）。
 *
 * 守住三条底线：
 * - **仍被业务引用的原件一律保留**（含退役但仍持外键的附件）；
 * - **已绑定的活件一律保留**；
 * - 未到保留窗口的不清理；到期的暂存行才进清理目标。
 */

import {
  decideStoredFileRetentionTargets,
  isStoredFileRetentionExpired,
  STORED_FILE_TEMPORARY_RETENTION_DAYS,
  type StoredFileRetentionCandidate,
} from './stored-file-retention.policy';

const NOW = new Date('2026-11-23T00:00:00.000Z');
const DAYS = STORED_FILE_TEMPORARY_RETENTION_DAYS;

function candidate(
  overrides: Partial<StoredFileRetentionCandidate> = {},
): StoredFileRetentionCandidate {
  return {
    fileId: 'file-1',
    ownerOrganizationId: 4,
    status: 'VALID',
    bindingStatus: 'TEMPORARY',
    businessId: null,
    createdAt: new Date(NOW.getTime() - (DAYS + 1) * 24 * 60 * 60 * 1000),
    referenced: false,
    ...overrides,
  };
}

describe('暂存原件保留窗口与过期清理（P3-3）', () => {
  it('保留窗口常量与判定：未到期不算过期', () => {
    expect(isStoredFileRetentionExpired(new Date(NOW.getTime() - 1000), NOW, DAYS)).toBe(false);
    expect(
      isStoredFileRetentionExpired(
        new Date(NOW.getTime() - (DAYS + 1) * 24 * 60 * 60 * 1000),
        NOW,
        DAYS,
      ),
    ).toBe(true);
  });

  it('到期且未被引用的暂存行 → 清理目标（EXPIRED_TEMPORARY）', () => {
    const decision = decideStoredFileRetentionTargets([candidate()], NOW, DAYS);

    expect(decision.targets).toHaveLength(1);
    expect(decision.targets[0].reason).toBe('EXPIRED_TEMPORARY');
    expect(decision.skipped).toHaveLength(0);
  });

  it('已被业务引用（含退役但仍持外键的附件）→ 保留', () => {
    const decision = decideStoredFileRetentionTargets([candidate({ referenced: true })], NOW, DAYS);

    expect(decision.targets).toHaveLength(0);
    expect(decision.skipped[0].reason).toBe('BUSINESS_REFERENCED');
  });

  it('已绑定（BOUND）或已有业务 id → 保留（活件不是孤儿）', () => {
    const bound = decideStoredFileRetentionTargets(
      [candidate({ bindingStatus: 'BOUND' })],
      NOW,
      DAYS,
    );
    expect(bound.targets).toHaveLength(0);
    expect(bound.skipped[0].reason).toBe('BOUND');

    const withBusinessId = decideStoredFileRetentionTargets(
      [candidate({ businessId: '42' })],
      NOW,
      DAYS,
    );
    expect(withBusinessId.targets).toHaveLength(0);
    expect(withBusinessId.skipped[0].reason).toBe('BOUND');
  });

  it('未到保留窗口 → 保留（不急删）', () => {
    const decision = decideStoredFileRetentionTargets(
      [candidate({ createdAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000) })],
      NOW,
      DAYS,
    );

    expect(decision.targets).toHaveLength(0);
    expect(decision.skipped[0].reason).toBe('NOT_EXPIRED');
  });

  it('已失效（STAGING／FAILED）且到期 → 清理目标（DEAD_STATUS）', () => {
    const decision = decideStoredFileRetentionTargets(
      [candidate({ status: 'FAILED' }), candidate({ fileId: 'file-2', status: 'STAGING' })],
      NOW,
      DAYS,
    );

    expect(decision.targets).toHaveLength(2);
    expect(decision.targets.every((target) => target.reason === 'DEAD_STATUS')).toBe(true);
  });

  it('保留优先于清理：被引用的项即使到期也不进目标', () => {
    const decision = decideStoredFileRetentionTargets(
      [candidate({ referenced: true }), candidate({ fileId: 'file-2' })],
      NOW,
      DAYS,
    );

    expect(decision.targets).toHaveLength(1);
    expect(decision.targets[0].candidate.fileId).toBe('file-2');
    expect(decision.skipped).toHaveLength(1);
  });
});
