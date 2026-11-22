// src/core/local-runtime/policy/sync-conflict-version.policy.spec.ts

/**
 * 冲突裁决的**展示版本新鲜度**裁决单测（任务 09 S2.2 收口）。
 *
 * 口径：
 * - 冲突登记的本地版本必须是来源记录的当前版本；
 * - 版本不可核验（冲突没登记本地版本／来源记录没有可信版本／版本不可信）→ 不放行；
 * - 不一致（来源记录已被别处推进）→ 不放行（`VERSION_STALE`）。
 *
 * 这层保护的是"用户裁决的是过期版本"：把"用云端"落到已被推进的记录上，
 * 会把裁决结论伪装成"用户已确认当前内容"。
 */

import {
  resolveSyncConflictVersionFreshness,
  type SyncConflictVersionFacts,
} from './sync-conflict-version.policy';

const baseFacts = (
  overrides: Partial<SyncConflictVersionFacts> = {},
): SyncConflictVersionFacts => ({
  conflictLocalVersion: 3,
  recordCurrentVersion: 3,
  versionTrusted: true,
  ...overrides,
});

describe('冲突裁决展示版本新鲜度裁决', () => {
  it('版本一致且可信 → 放行', () => {
    const result = resolveSyncConflictVersionFreshness(baseFacts());

    expect(result).toEqual({ fresh: true, reason: 'VERSION_MATCH' });
  });

  it('冲突没登记本地版本 → 不可核验，不放行', () => {
    const result = resolveSyncConflictVersionFreshness(baseFacts({ conflictLocalVersion: null }));

    expect(result).toEqual({ fresh: false, reason: 'VERSION_UNVERIFIABLE' });
  });

  it('来源记录没有可信版本 → 不可核验，不放行', () => {
    const result = resolveSyncConflictVersionFreshness(baseFacts({ recordCurrentVersion: null }));

    expect(result).toEqual({ fresh: false, reason: 'VERSION_UNVERIFIABLE' });
  });

  it('版本本身不可信 → 不可核验，不放行', () => {
    const result = resolveSyncConflictVersionFreshness(baseFacts({ versionTrusted: false }));

    expect(result).toEqual({ fresh: false, reason: 'VERSION_UNVERIFIABLE' });
  });

  it('版本不一致（记录已被别处推进）→ 过期，不放行', () => {
    const result = resolveSyncConflictVersionFreshness(baseFacts({ recordCurrentVersion: 4 }));

    expect(result).toEqual({ fresh: false, reason: 'VERSION_STALE' });
  });
});
