// src/core/local-runtime/policy/sync-conflict-version.policy.ts

/**
 * 冲突裁决的**展示版本新鲜度**裁决（任务 09 S2.2 收口）。
 *
 * 为什么需要：裁决是一次写动作，写的是"我对当前看到的内容作出的选择"。
 * 冲突登记之后，来源记录可能已被别处推进（本地改了、云端改了、材料下架）。
 * 此时用户裁决的是**过期版本**：把"用云端"落到一个已经变化的记录上，
 * 会把裁决结论伪装成"用户已确认当前内容"。
 *
 * 与「保留本地」入口的展示版本二次校验**共用同一个版本比较点**
 * （`compareConflictVersionToRecord`，见 `sync-conflict-local-resolution.policy.ts`）：
 * - 冲突登记的本地版本必须是来源记录的**当前版本**；
 * - 版本不可核验（冲突没登记本地版本 / 来源记录没有可信版本）→ 不放行；
 * - 不一致 → 不放行（`VERSION_STALE`）。
 *
 * 两条裁决路径的**差异**（有意并存，不是重复实现）：
 * - 本策略只回答"看到的还是不是当前版本"；
 * - 「保留本地」还要额外回答"这次裁决的正文是否已经写过"（幂等重放判定），
 *   那是写入编排的职责，不是版本新鲜度的职责。
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

/**
 * 冲突登记版本与来源记录当前版本的**唯一比较点**。
 *
 * 两条裁决路径（使用云端／保留本地）都必须经过这里，避免同一事实被比较两遍
 * 并给出两套错误码。
 */
export function compareConflictVersionToRecord(facts: {
  /** 冲突登记的本地展示版本 */
  conflictLocalVersion: number | null;
  /** 来源记录当前业务版本 */
  recordCurrentVersion: number | null;
  /** 来源记录当前版本是否可核验 */
  versionTrusted: boolean;
}): 'MATCH' | 'STALE' | 'UNVERIFIABLE' {
  if (
    facts.conflictLocalVersion === null ||
    facts.recordCurrentVersion === null ||
    !facts.versionTrusted
  ) {
    return 'UNVERIFIABLE';
  }
  return facts.conflictLocalVersion === facts.recordCurrentVersion ? 'MATCH' : 'STALE';
}

export type SyncConflictVersionOutcome = {
  /** 是否可以按当前展示版本执行裁决 */
  fresh: boolean;
  reason: SyncConflictVersionReason;
};

/** 冲突裁决的展示版本新鲜度裁决（纯函数） */
export function resolveSyncConflictVersionFreshness(
  facts: SyncConflictVersionFacts,
): SyncConflictVersionOutcome {
  const comparison = compareConflictVersionToRecord(facts);
  if (comparison === 'UNVERIFIABLE') {
    return { fresh: false, reason: 'VERSION_UNVERIFIABLE' };
  }
  if (comparison === 'STALE') {
    return { fresh: false, reason: 'VERSION_STALE' };
  }
  return { fresh: true, reason: 'VERSION_MATCH' };
}
