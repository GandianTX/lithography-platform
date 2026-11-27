// src/core/local-runtime/policy/local-write-hold.policy.ts

/**
 * 写入／同步冻结的**范围与准入裁决**（任务 09 S5-2）。
 *
 * 需求："实现受影响设备公司范围的写入／同步冻结……核验后解除冻结"。
 * 口径：
 * - 冻结**按公司数据区**判定：本机某公司被冻结 ⇒ 该公司的写入与同步被拒，
 *   其它公司**不受影响**（不做全设备一刀切，避免误伤）；
 * - 冻结期内**只允许恢复执行自身**的写入（恢复要能写回数据），
 *   其余写入／派发一律拒绝并给出**受控原因码**（前端按码映射文案）；
 * - 判定是**纯函数**（无 I/O、无 DI）：事实由事实层取，裁决只有这一处。
 */

/** 冻结类型（当前只有恢复期冻结） */
export const LOCAL_WRITE_HOLD_TYPES = {
  /** 恢复期写入/同步冻结 */
  RESTORE: 'RESTORE',
} as const;

export type LocalWriteHoldType =
  (typeof LOCAL_WRITE_HOLD_TYPES)[keyof typeof LOCAL_WRITE_HOLD_TYPES];

/** 冻结原因码（对外只给码） */
export const LOCAL_WRITE_HOLD_REASON_CODES = {
  /** 目标公司数据区处于恢复期冻结：写入与同步被拒 */
  WRITE_HELD_FOR_RESTORE: 'WRITE_HELD_FOR_RESTORE',
  /** 目标公司数据区已被**其它**恢复占用：本次恢复不得并行写入该范围 */
  WRITE_HELD_FOR_RESTORE_SCOPE_OCCUPIED: 'WRITE_HELD_FOR_RESTORE_SCOPE_OCCUPIED',
  /** 解除冻结被拒：当前操作方不是该条冻结的持有者（不可伪造的所有权） */
  RELEASE_NOT_PERMITTED_NOT_OWNER: 'RELEASE_NOT_PERMITTED_NOT_OWNER',
  /**
   * 范围锁不可得：目标公司数据区的范围锁被长事务占住（等待超时／死锁）
   * 或范围行建立后仍无法加锁 ⇒ 本次写入**失败关闭**（不放行）。
   */
  WRITE_HELD_FOR_RESTORE_SCOPE_BUSY: 'WRITE_HELD_FOR_RESTORE_SCOPE_BUSY',
} as const;

export type LocalWriteHoldReasonCode =
  (typeof LOCAL_WRITE_HOLD_REASON_CODES)[keyof typeof LOCAL_WRITE_HOLD_REASON_CODES];

/**
 * 恢复范围的**占用裁决**（纯函数；事实由事实层取）。
 *
 * 为什么需要它：`hold()` 之前是"先查后写"，且会把已有 ACTIVE 冻结的
 * `restore_id` **覆盖**成新的恢复 ID ⇒ 别人的占用被抢走、原持有者失去
 * 释放资格。这一裁决把三种情形分开：
 *
 * - **同一恢复**（`existingRestoreId === requestedRestoreId`）⇒ 允许：
 *   幂等重试与"崩溃后收口"都必须能继续，否则中断的恢复再也收不回来；
 * - **无主旧冻结**（`existingRestoreId` 为空）⇒ 允许接管，但接管者**不得**
 *   反向覆盖成别的恢复 ID 之外的事实；
 * - **其它恢复占用**（两者都不为空且不同）⇒ **拒绝**：同一安装×公司
 *   在同一时刻只允许一个恢复写入。
 */
export function decideRestoreScopeOccupancyVerdict(input: {
  /** 已存在的 ACTIVE 冻结关联的恢复 ID（无主旧冻结为 null） */
  existingRestoreId: string | null;
  /** 本次请求占用该范围的恢复 ID */
  requestedRestoreId: string | null;
  /** 同范围内**实际**存在的 ACTIVE 冻结条数（>1 说明历史冲突） */
  activeHoldCount: number;
}):
  | { readonly allowed: true; readonly reason: string }
  | {
      readonly allowed: false;
      readonly reasonCode: LocalWriteHoldReasonCode;
      readonly reason: string;
    } {
  if (input.activeHoldCount > 1) {
    // 历史冲突：同范围存在多条 ACTIVE 冻结 ⇒ 无法判定归属，失败关闭，
    // 不静默挑一条（挑错会把别人的现场当成自己的）。
    return {
      allowed: false,
      reasonCode: LOCAL_WRITE_HOLD_REASON_CODES.WRITE_HELD_FOR_RESTORE_SCOPE_OCCUPIED,
      reason:
        `目标公司数据区存在 ${input.activeHoldCount} 条并存的恢复期冻结` +
        '（历史冲突，无法判定归属），请人工核对后清理',
    };
  }
  if (
    input.existingRestoreId !== null &&
    input.requestedRestoreId !== null &&
    input.existingRestoreId !== input.requestedRestoreId
  ) {
    return {
      allowed: false,
      reasonCode: LOCAL_WRITE_HOLD_REASON_CODES.WRITE_HELD_FOR_RESTORE_SCOPE_OCCUPIED,
      reason: `目标公司数据区已被其它恢复占用（${input.existingRestoreId}），本次恢复不得并行写入`,
    };
  }
  return {
    allowed: true,
    reason:
      input.existingRestoreId === null
        ? '目标公司数据区无既有恢复占用'
        : '目标公司数据区已由本次恢复占用（幂等重试或崩溃后收口）',
  };
}

/**
 * 解除冻结的**所有权裁决**（纯函数）。
 *
 * 释放必须验证当前持有者：没有所有权校验时，任何一次"按范围释放"
 * 都能把**别人**的恢复期冻结解掉 ⇒ 恢复期间目标公司数据区重新可写，
 * 恢复写回的结果被并发业务写入污染。
 */
export function decideWriteHoldReleaseVerdict(input: {
  /** 该条 ACTIVE 冻结关联的恢复 ID */
  ownerRestoreId: string | null;
  /** 本次请求释放时声明的恢复 ID */
  requestedRestoreId: string | null;
  /** 该范围当前是否存在 ACTIVE 冻结 */
  hasActiveHold: boolean;
}):
  | { readonly allowed: true; readonly reason: string }
  | {
      readonly allowed: false;
      /** `null`＝没有 ACTIVE 冻结（幂等：如实返回"未释放"，不是权限问题） */
      readonly reasonCode: LocalWriteHoldReasonCode | null;
      readonly reason: string;
    } {
  if (!input.hasActiveHold) {
    // 没有 ACTIVE 冻结 ⇒ 无可释放（幂等：释放请求重复到达时如实返回"未释放"）
    return { allowed: false, reasonCode: null, reason: '目标公司数据区当前没有恢复期冻结' };
  }
  if (input.ownerRestoreId !== null && input.ownerRestoreId !== input.requestedRestoreId) {
    // 归属存在时，**必须**由同一个恢复来解除：
    // 请求方未声明归属（null）或声明了别的恢复 ⇒ 一律拒绝，
    // 否则"按范围一刀切"的释放就能解掉别人的冻结。
    return {
      allowed: false,
      reasonCode: LOCAL_WRITE_HOLD_REASON_CODES.RELEASE_NOT_PERMITTED_NOT_OWNER,
      reason:
        input.requestedRestoreId === null
          ? '该恢复期冻结已有持有者，当前操作方未声明归属，不得解除'
          : `该恢复期冻结由其它恢复持有（${input.ownerRestoreId}），当前操作方不得解除`,
    };
  }
  return { allowed: true, reason: '当前操作方是该恢复期冻结的持有者' };
}

/**
 * 现场强制解冻的**归属裁决**（纯函数）。
 *
 * 为什么单独一条裁决：`forceReleaseForRecoveryIncident()` 面对的是
 * **"历史库遗留的多条并存 ACTIVE 冻结"**（同范围多条，见
 * `decideRestoreScopeOccupancyVerdict` 的同一条口径）。此时若按
 * "范围里的任意一行"判归属，就会出现两种错误：
 * - 取到**别人**那行 ⇒  rightful 持有者被误判为越权 ⇒ 其冻结解不掉
 *   ⇒ 该公司数据区**永久停写**（只能人工改库）；
 * - 取到**自己**那行 ⇒ 侥幸通过，但语义仍是"碰巧"，换一行就翻转。
 *
 * 正确口径：**只有"由请求方持有的冻结"才可被释放**。
 * - 归属判定只看**请求方自己持有的条数**，与行序无关（可重复、可解释）；
 * - 释放动作也只作用于这些行（同一次 `update ... where restore_id = ?`），
 *   别人的冻结**永远不受影响**；
 * - 请求方在该范围内**没有**任何冻结 ⇒ 失败关闭（不允许"按范围一刀切"）。
 */
export function decideIncidentForceReleaseVerdict(input: {
  /** 同范围内、由请求方持有的 ACTIVE 冻结条数 */
  ownedHoldCount: number;
  /** 请求方声明的现场恢复 ID（仅用于说明，不参与裁决） */
  incidentRestoreId: string;
}):
  | { readonly allowed: true; readonly reason: string }
  | {
      readonly allowed: false;
      readonly reasonCode: LocalWriteHoldReasonCode;
      readonly reason: string;
    } {
  if (input.ownedHoldCount > 0) {
    return {
      allowed: true,
      reason: `该现场持有 ${input.ownedHoldCount} 条恢复期冻结，按归属解除（不影响他人冻结）`,
    };
  }
  return {
    allowed: false,
    reasonCode: LOCAL_WRITE_HOLD_REASON_CODES.RELEASE_NOT_PERMITTED_NOT_OWNER,
    reason:
      `目标公司数据区当前没有属于该恢复现场（${input.incidentRestoreId}）的恢复期冻结` +
      '（历史冲突或归属不符），不得按范围一刀切解除',
  };
}

/** 参与裁决的冻结事实（只取判定需要的字段） */
export type LocalWriteHoldFact = {
  organizationId: number;
  holdType: string;
  status: string;
  reason: string;
};

/** 写入/同步准入裁决结论 */
export type LocalWriteHoldVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reasonCode: LocalWriteHoldReasonCode;
      readonly reason: string;
    };

/**
 * 裁决一次写入／同步是否被冻结拒绝。
 *
 * @param scope.organizationId 目标公司数据区
 * @param holds 本机当前的冻结事实（只读 ACTIVE 的才由调用方传入）
 */
export function decideLocalWriteHoldVerdict(input: {
  organizationId: number;
  holds: readonly LocalWriteHoldFact[];
}): LocalWriteHoldVerdict {
  const held = input.holds.find(
    (hold) =>
      hold.organizationId === input.organizationId &&
      hold.status === 'ACTIVE' &&
      hold.holdType === LOCAL_WRITE_HOLD_TYPES.RESTORE,
  );
  if (held === undefined) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reasonCode: LOCAL_WRITE_HOLD_REASON_CODES.WRITE_HELD_FOR_RESTORE,
    reason: `目标公司数据区处于恢复期冻结（${held.reason}），写入与同步已被拒绝`,
  };
}
