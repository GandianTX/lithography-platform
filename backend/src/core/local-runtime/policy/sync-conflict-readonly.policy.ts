// src/core/local-runtime/policy/sync-conflict-readonly.policy.ts

/**
 * 冲突裁决的「只读内容不得**反写**」裁决（任务 09 S2.3）。
 *
 * 目标：**保留本地**（把本地内容写回来源业务）**不得**把内容写回已经只读的来源记录。
 * 只读来源有三类事实：
 * 1. **已删除／已下架**：记录已不在可写集合里，任何恢复都是把下架内容搬回来；
 * 2. **冻结**：内容正在被别处推进（工单处理中、报告待审核、资料归属待确认），
 *    此时覆盖会抹掉正在进行的工作；
 * 3. **结单**：业务已完成（工单已关闭、报告已通过），内容只读。
 *
 * 口径说明（**待维护者确认**）：任务书只写"禁止恢复已删除／下架／冻结／结单只读内容"，
 * 未定义"冻结"与"结单"在各来源的字段映射。本文件按现有状态列做如下映射，
 * 与只读策略保持一致，不新增业务状态：
 * - 工单：冻结＝`handling_status='IN_PROGRESS'`；结单＝`closure_status='CLOSED'`；
 * - 报告：冻结＝`status='PENDING_REVIEW'`；结单＝`status='APPROVED'`；
 * - 资料：冻结＝`ownership_status='PENDING'`（归属待确认）。
 *
 * **「使用云端」与「保留本地」的口径不同**（R066／R068）：
 * 已结单内容**不允许保留本地反写**，但**允许有读取权的用户采用云端视图**
 * （只呈现、不写业务记录、不改历史）——见 `resolveSyncConflictCloudAdoption`。
 *
 * 裁决是纯函数：事实由上层从数据库取得，不接受调用方自报。
 */

/** 来源内容只读事实 */
export type SyncConflictReadOnlyFacts = {
  /** 已删除／已下架 */
  withdrawn: boolean;
  /** 冻结：内容正在被别处推进 */
  frozen: boolean;
  /** 结单：业务已完成 */
  closed: boolean;
};

/** 只读裁决结果 */
export type SyncConflictReadOnlyOutcome = {
  /** 是否为只读内容（只读即不得恢复／覆盖） */
  readOnly: boolean;
  /** 受控原因码；非只读时为 null */
  reason: 'SOURCE_WITHDRAWN' | 'SOURCE_FROZEN' | 'SOURCE_CLOSED' | null;
};

/**
 * 只读裁决（纯函数）。
 *
 * 顺序：删除／下架 → 冻结 → 结单。首个成立的原因即为对外原因码。
 */
export function resolveSyncConflictReadOnly(
  facts: SyncConflictReadOnlyFacts,
): SyncConflictReadOnlyOutcome {
  if (facts.withdrawn) {
    return { readOnly: true, reason: 'SOURCE_WITHDRAWN' };
  }
  if (facts.frozen) {
    return { readOnly: true, reason: 'SOURCE_FROZEN' };
  }
  if (facts.closed) {
    return { readOnly: true, reason: 'SOURCE_CLOSED' };
  }
  return { readOnly: false, reason: null };
}

/**
 * 采用云端视图的裁决结果（纯函数，R066／R067）。
 *
 * 与"只读"口径的差别（R066 明确要求）：
 * - **已结单（closed）**：业务已完成、内容只读，但**允许有读取权的用户采用云端视图**。
 *   采用只是把云端内容呈现为本地视图，**不写业务记录、不改历史**，
 *   采用者也**不因此获得任何写入权**（云端原记录与历史一律不动）。
 * - **已删除／已下架（withdrawn）**：内容已不在可写集合里，采用等于把下架内容搬回来 ⇒ 拒绝。
 * - **冻结（frozen）**：内容正在被别处推进，覆盖会抹掉正在进行的工作 ⇒ 拒绝。
 */
export type SyncConflictCloudAdoptionOutcome = {
  /** 是否允许采用云端视图 */
  adoptable: boolean;
  /** 受控原因码；非空即表示拒绝采用 */
  reason: 'SOURCE_WITHDRAWN' | 'SOURCE_FROZEN' | null;
  /** 是否为**只读采用**（来源已结单）：只呈现视图，不获得写入权 */
  readOnlyAdoption: boolean;
};

/**
 * 采用云端视图的准入裁决（纯函数）。
 *
 * 顺序与只读口径一致：删除／下架 → 冻结 → 结单。
 */
export function resolveSyncConflictCloudAdoption(
  facts: SyncConflictReadOnlyFacts,
): SyncConflictCloudAdoptionOutcome {
  if (facts.withdrawn) {
    return { adoptable: false, reason: 'SOURCE_WITHDRAWN', readOnlyAdoption: false };
  }
  if (facts.frozen) {
    return { adoptable: false, reason: 'SOURCE_FROZEN', readOnlyAdoption: false };
  }
  if (facts.closed) {
    return { adoptable: true, reason: null, readOnlyAdoption: true };
  }
  return { adoptable: true, reason: null, readOnlyAdoption: false };
}
