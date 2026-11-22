// src/core/local-runtime/policy/sync-conflict-version.policy.ts

/**
 * 冲突裁决的**展示版本新鲜度**裁决（任务 09 S2.2 收口）。
 *
 * 为什么需要：裁决是一次写动作，写的是"我对当前看到的内容作出的选择"。
 * 冲突登记之后，来源记录可能已被别处推进（本地改了、云端改了、材料下架）。
 * 此时用户裁决的是**过期版本**：把"用云端"落到一个已经变化的记录上，
 * 会把裁决结论伪装成"用户已确认当前内容"。
 *
 * 口径与「保留本地」入口的展示版本二次校验对称
 * （见 `apply-local-sync-conflict-resolution.usecase.ts`）：
 * - 冲突登记的本地版本必须是来源记录的**当前版本**；
 * - 版本不可核验（冲突没登记本地版本 / 来源记录没有可信版本）→ 不放行；
 * - 不一致 → 不放行（`VERSION_STALE`）。
 *
 * 只做纯裁决：冲突登记版本与来源记录事实必须由上层从数据库取得，
 * 不接受客户端传入的版本。
 */

export type SyncConflictVersionFacts = {
  /** 冲突登记的本地展示版本；null 表示没有登记可用版本 */
  conflictLocalVersion: number | null;
  /** 来源记录当前业务版本；null 表示没有可信版本 */
  recordCurrentVersion: number | null;
  /** 来源记录当前版本是否可核验 */
  versionTrusted: boolean;
};

export type SyncConflictVersionReason =
  /** 冲突登记的版本仍是来源记录的当前版本 */
  | 'VERSION_MATCH'
  /** 版本不可核验（缺版本或版本不可信） */
  | 'VERSION_UNVERIFIABLE'
  /** 版本已过期：来源记录已被别处推进 */
  | 'VERSION_STALE';

export type SyncConflictVersionOutcome = {
  /** 是否可以按当前展示版本执行裁决 */
  fresh: boolean;
  reason: SyncConflictVersionReason;
};

/** 冲突裁决的展示版本新鲜度裁决（纯函数） */
export function resolveSyncConflictVersionFreshness(
  facts: SyncConflictVersionFacts,
): SyncConflictVersionOutcome {
  if (
    facts.conflictLocalVersion === null ||
    facts.recordCurrentVersion === null ||
    !facts.versionTrusted
  ) {
    return { fresh: false, reason: 'VERSION_UNVERIFIABLE' };
  }
  if (facts.conflictLocalVersion !== facts.recordCurrentVersion) {
    return { fresh: false, reason: 'VERSION_STALE' };
  }
  return { fresh: true, reason: 'VERSION_MATCH' };
}
