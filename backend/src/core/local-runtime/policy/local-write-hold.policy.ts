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
} as const;

export type LocalWriteHoldReasonCode =
  (typeof LOCAL_WRITE_HOLD_REASON_CODES)[keyof typeof LOCAL_WRITE_HOLD_REASON_CODES];

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
