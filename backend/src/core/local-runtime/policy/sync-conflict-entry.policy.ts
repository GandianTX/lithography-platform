// src/core/local-runtime/policy/sync-conflict-entry.policy.ts

/**
 * 冲突处理入口的写权与版本二次校验纯规则（任务 09 后续S1.6）。
 *
 * 为什么需要独立裁决：状态查询侧给出 `canResolveConflict` 就等于向调用方承诺
 * 「点进去能处理」。若该承诺与真正的裁决入口口径不一致，就会出现
 * 「有入口但一进去就报不在授权范围内」或更糟——把不属于当前展示内容的冲突
 * 当成可处理对象。因此入口资格必须与 `resolve-sync-conflict.usecase.ts`
 * 的实际准入**逐条对齐**，并在此之上补一条版本二次校验。
 *
 * 写权口径（与裁决入口一致，不额外收窄）：
 * - 一级管理员为全局授权范围（`scopeOrganizationId = null`）→ 放行；
 * - 工程师与二级管理员限本公司数据区 → 冲突归属公司必须命中；
 * - 记录级授权（本人／同公司／一级管理员）已在上游裁决，可读才谈得上处理。
 *
 * 版本二次校验（防止处理"用户没在看的那个版本"）：
 * - 调用方必须给出当前展示版本，且与服务端认定的当前版本一致；
 * - 该版本还必须落在冲突固化的版本集合（本地版本／云端版本／旧版本号／
 *   冲突登记时已展示的云端版本）之内；
 * - 任一条件不满足 → 不给入口（失败关闭）。
 *
 * 只做纯裁决：事实（查看者范围、冲突归属、状态、版本）必须由上层从数据库与
 * 请求中取得，不接受客户端传入的公司或版本作为裁决依据。
 */

/** 冲突处理入口的判定理由（内部诊断用，不对外暴露） */
export type SyncConflictEntryReason =
  'ALLOWED' | 'NOT_READABLE' | 'FOREIGN_COMPANY' | 'CONFLICT_NOT_PENDING' | 'VERSION_NOT_ALIGNED';

export type SyncConflictEntryFacts = {
  /** 查看者范围公司；null 表示一级管理员的全局授权范围 */
  scopeOrganizationId: number | null;
  /** 冲突归属公司（服务端事实） */
  conflictOrganizationId: number;
  /** 记录级授权是否通过（可读） */
  recordReadable: boolean;
  /** 冲突当前状态；只有 PENDING 才存在可处理的冲突 */
  conflictStatus: string;
  /** 调用方当前展示的版本；null 表示未提供 */
  displayedVersion: number | null;
  /** 服务端认定的当前版本；不可核验时为 null */
  serverCurrentVersion: number | null;
  /** 冲突固化的版本集合（含 null 表示历史未知的版本位） */
  conflictVersions: readonly (number | null)[];
};

export type SyncConflictEntryOutcome = {
  /** 是否给出处理入口 */
  allowed: boolean;
  reason: SyncConflictEntryReason;
};

/**
 * 冲突处理入口裁决（纯函数）。
 *
 * 顺序：可读 → 公司范围 → 冲突状态 → 版本二次校验。
 */
export function resolveSyncConflictEntry(facts: SyncConflictEntryFacts): SyncConflictEntryOutcome {
  if (!facts.recordReadable) {
    return { allowed: false, reason: 'NOT_READABLE' };
  }

  // 范围校验与裁决入口一致：一级管理员全局，其余必须命中本公司数据区
  if (
    facts.scopeOrganizationId !== null &&
    facts.scopeOrganizationId !== facts.conflictOrganizationId
  ) {
    return { allowed: false, reason: 'FOREIGN_COMPANY' };
  }

  // 只有待处理冲突才谈得上处理（已裁决/已忽略的冲突不给入口）
  if (facts.conflictStatus !== 'PENDING') {
    return { allowed: false, reason: 'CONFLICT_NOT_PENDING' };
  }

  if (!isDisplayedVersionAligned(facts)) {
    return { allowed: false, reason: 'VERSION_NOT_ALIGNED' };
  }

  return { allowed: true, reason: 'ALLOWED' };
}

/**
 * 当前展示版本二次校验：
 * 调用方展示的版本必须与服务端当前版本一致，且落在冲突固化的版本集合内。
 */
function isDisplayedVersionAligned(facts: SyncConflictEntryFacts): boolean {
  const displayed = facts.displayedVersion;
  const current = facts.serverCurrentVersion;
  if (displayed === null || current === null) {
    // 未提供展示版本或服务端版本不可核验时无法核对 → 失败关闭
    return false;
  }
  if (displayed !== current) {
    return false;
  }
  return facts.conflictVersions.includes(displayed);
}
