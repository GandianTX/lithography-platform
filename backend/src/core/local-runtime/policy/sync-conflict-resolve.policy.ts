// src/core/local-runtime/policy/sync-conflict-resolve.policy.ts

import { SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';

/**
 * 冲突裁决纯规则（任务 09 R067／R068／R069，S2.2）。
 *
 * 输入是**裁决前事实**（状态与既有 decision），输出是允许的裁决动作。
 * 这里不触碰数据库，也不生成业务修订——`LOCAL` 需要来源业务的受控版本写入
 * 入口（X04），本层只判断"该不该允许"，"怎么写"由 usecase/service 决定。
 */

/**
 * GraphQL 枚举对象（registerEnumType 要求键值映射，不能是数组）。
 * 取值与 DB CHECK／需求用语一致：使用云端（CLOUD）、保留本地（LOCAL）、稍后处理（LATER）。
 */
export const syncConflictActionEnum = {
  CLOUD: 'CLOUD',
  LOCAL: 'LOCAL',
  LATER: 'LATER',
} as const;
export type SyncConflictAction =
  (typeof syncConflictActionEnum)[keyof typeof syncConflictActionEnum];

/** 全部合法动作值（用于运行时归一化校验） */
export const SYNC_CONFLICT_ACTIONS = Object.values(
  syncConflictActionEnum,
) as readonly SyncConflictAction[];

/** DB CHECK 实际取值（`chk_sync_conflict_status`） */
export const SYNC_CONFLICT_STATUSES = ['PENDING', 'RESOLVED', 'IGNORED'] as const;
export type SyncConflictStatus = (typeof SYNC_CONFLICT_STATUSES)[number];

/** DB CHECK 实际取值（`chk_sync_conflict_decision`），NULL 表示历史未知行 */
export const SYNC_CONFLICT_DECISIONS = ['PENDING', 'LOCAL', 'CLOUD'] as const;
export type SyncConflictDecision = (typeof SYNC_CONFLICT_DECISIONS)[number];

export type SyncConflictDecisionFacts = {
  status: SyncConflictStatus;
  decision: SyncConflictDecision | null;
};

/**
 * 裁决结果：
 * - `write` 需要写库（只有 CLOUD / LOCAL 需要落确认人与 decision）
 * - `existing` 表示"重复请求返回既有事实"，服务端不重复写、不生成第二个修订
 * - `later` 表示"稍后处理"，保持 PENDING 且**绝不写确认人**（R069）
 */
export type SyncConflictResolveOutcome =
  | { kind: 'write'; action: 'CLOUD' | 'LOCAL'; decision: SyncConflictDecision }
  | { kind: 'existing' }
  | { kind: 'later' };

/**
 * 裁决规则：
 * 1. 已裁决（RESOLVED／IGNORED）的冲突：
 *    - 重复相同方向（云端/本地）→ 返回既有事实，不再写；
 *    - 换方向 → 显式拒绝，不允许覆盖既有确认（R068：冲突不静默覆盖）；
 *    - 稍后处理 → 已裁决的记录没有"稍后"可言，返回既有事实。
 * 2. 待处理冲突：
 *    - 稍后处理 → 保持 PENDING；
 *    - 使用云端 → 只写 decision/确认人，不回写云端原记录；
 *    - 保留本地 → 需要生成一次新修订，属受控写入。
 * 3. `LOCAL` 在受控版本写入入口（X04）接入前一律显式失败，不做静默覆盖。
 */
export function resolveSyncConflictOutcome(
  facts: SyncConflictDecisionFacts,
  action: SyncConflictAction,
): SyncConflictResolveOutcome {
  if (facts.status !== 'PENDING') {
    if (action === 'LATER') {
      return { kind: 'existing' };
    }
    if (action === 'CLOUD' && facts.decision === 'CLOUD') {
      return { kind: 'existing' };
    }
    if (action === 'LOCAL' && facts.decision === 'LOCAL') {
      return { kind: 'existing' };
    }
    throw new DomainError(
      SYNC_ERROR.CONFLICT_ALREADY_RESOLVED,
      '该冲突已被处理为另一个方向，不能覆盖既有确认',
    );
  }

  if (action === 'LATER') {
    // 稍后处理：保留待处理状态；已存在 decision 的事实不动
    return { kind: 'later' };
  }
  if (action === 'CLOUD') {
    return { kind: 'write', action: 'CLOUD', decision: 'CLOUD' };
  }
  // LOCAL：需要来源业务受控写入入口（X04），未接入前显式失败
  throw new DomainError(
    SYNC_ERROR.LOCAL_RESOLUTION_NOT_AVAILABLE,
    '保留本地需要来源业务的受控版本写入入口，尚未接入',
  );
}
