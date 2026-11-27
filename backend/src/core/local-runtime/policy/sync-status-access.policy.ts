// src/core/local-runtime/policy/sync-status-access.policy.ts

import type { LocalRuntimeViewerScope } from './local-runtime-viewer-scope.policy';

/**
 * 同步状态的记录级授权纯规则（任务 09 后续S1／S2）。
 *
 * 为什么要记录级：任务 07 现有 `syncConflicts`／`syncConflict` 只按**公司范围**过滤，
 * 就能返回冲突快照；同一公司内不同人员可见的记录并不相同，直接按公司范围复用会把
 * 不可读记录的同步事实暴露出去。本策略按「本人／同公司／一级管理员」逐记录裁决。
 *
 * 只做纯裁决：事实（会话账号、查看者范围、记录归属与关联账号）必须由上层从
 * 数据库／会话取得；不接受客户端传入的公司或版本。
 */
export type SyncStatusAccessFacts = {
  /** 会话账号 */
  sessionAccountId: number;
  /** 查看者范围（由服务端按会话复核） */
  scope: LocalRuntimeViewerScope;
  /** 记录归属公司；null 表示归属未知（存量无证据） */
  ownerOrganizationId: number | null;
  /** 与该记录关联的账号（作者／客户／受理人等） */
  relatedAccountIds: readonly number[];
};

export type SyncStatusAccessReason =
  'ADMIN_GLOBAL' | 'SELF' | 'SAME_COMPANY' | 'DENIED_COMPANY' | 'DENIED_UNKNOWN_OWNER';

export type SyncStatusAccessOutcome = {
  allowed: boolean;
  reason: SyncStatusAccessReason;
};

/**
 * 记录级授权裁决。
 *
 * - 一级管理员：全局授权范围，放行；
 * - 工程师／二级管理员：先按可信公司核对归属，再区分本人与同公司；
 * - 归属未知（`ownerOrganizationId = null`）不放行：宁可不出状态，也不猜归属。
 */
export function resolveSyncStatusAccess(facts: SyncStatusAccessFacts): SyncStatusAccessOutcome {
  if (facts.scope.role === 'ADMIN_LEVEL_1') {
    return { allowed: true, reason: 'ADMIN_GLOBAL' };
  }

  if (facts.ownerOrganizationId === null) {
    return { allowed: false, reason: 'DENIED_UNKNOWN_OWNER' };
  }

  if (facts.ownerOrganizationId !== facts.scope.organizationId) {
    return { allowed: false, reason: 'DENIED_COMPANY' };
  }

  if (facts.relatedAccountIds.includes(facts.sessionAccountId)) {
    return { allowed: true, reason: 'SELF' };
  }

  return { allowed: true, reason: 'SAME_COMPANY' };
}
