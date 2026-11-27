// src/core/local-runtime/policy/sync-conflict-access.policy.ts

import type { LocalRuntimeViewerScope } from './local-runtime-viewer-scope.policy';
import { resolveSyncStatusAccess, type SyncStatusAccessOutcome } from './sync-status-access.policy';

/**
 * 冲突读取的记录级授权纯规则（任务 09 后续S2·S2.2）。
 *
 * 为什么需要：任务书 S2.2 明确要求「**冲突先查元数据授权再读正文**」。
 * 现状缺口：`syncConflicts`／`syncConflict` 只按**公司范围**过滤就把
 * `localSnapshot`／`cloudSnapshot`（含正文与原件引用）返回给调用方，
 * 同一公司内不可读记录的同步事实会被一并带出。
 *
 * 裁决顺序：
 * 1. **记录事实不可取得 → 不放行**：来源记录读不到（记录已删除、资源类型不在
 *    白名单、归属公司已变更等）时，无法核验记录级授权。此时宁可不给条目，
 *    也不把"读不到授权依据"当成"有权看"——按不泄露存在性的口径处理；
 * 2. 记录事实可取得 → 复用**记录级授权**口径（`resolveSyncStatusAccess`）：
 *    一级管理员全局放行；工程师／二级管理员按可信公司核对归属，区分本人与同公司；
 *    跨公司与归属未知一律拒绝。
 *
 * 只做纯裁决：会话账号、查看者范围、冲突登记公司与来源记录事实必须由上层从
 * 数据库与会话取得，不接受客户端传入的公司或版本。
 */
export type SyncConflictAccessFacts = {
  /** 会话账号（来自可信 Session） */
  sessionAccountId: number;
  /** 查看者范围（服务端按会话复核） */
  scope: LocalRuntimeViewerScope;
  /**
   * 冲突登记公司（冲突行事实）。
   * 保留在事实里是为了让调用方能解释"冲突属于哪个数据区"，
   * 但**不参与放行判断**：放行只取决于来源记录的归属与关联账号。
   */
  conflictOrganizationId: number;
  /** 来源记录事实是否可取得 */
  recordResolved: boolean;
  /** 记录归属公司；null 表示归属未知（存量无证据） */
  ownerOrganizationId: number | null;
  /** 与该记录关联的账号（作者／客户／受理人等） */
  relatedAccountIds: readonly number[];
};

export type SyncConflictAccessReason =
  SyncStatusAccessOutcome['reason'] | 'DENIED_RECORD_UNRESOLVED';

export type SyncConflictAccessOutcome = {
  allowed: boolean;
  reason: SyncConflictAccessReason;
};

/** 冲突读取的记录级授权裁决（纯函数） */
export function resolveSyncConflictAccess(
  facts: SyncConflictAccessFacts,
): SyncConflictAccessOutcome {
  if (!facts.recordResolved) {
    return { allowed: false, reason: 'DENIED_RECORD_UNRESOLVED' };
  }

  const access = resolveSyncStatusAccess({
    sessionAccountId: facts.sessionAccountId,
    scope: facts.scope,
    ownerOrganizationId: facts.ownerOrganizationId,
    relatedAccountIds: facts.relatedAccountIds,
  });
  return { allowed: access.allowed, reason: access.reason };
}
