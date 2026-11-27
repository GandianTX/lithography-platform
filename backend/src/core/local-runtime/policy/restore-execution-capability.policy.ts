// src/core/local-runtime/policy/restore-execution-capability.policy.ts
// 恢复执行能力裁决（任务 09 S4；review M11）。
//
// 定位（review M11）："当前环境能不能执行恢复"是**领域裁决**，不在 adapter 里硬编码。
// 本文件是唯一的裁决点：adapter 只做协议映射，事实由用例编排取，回调结论按码表达。
//
// 口径（R082-01／R085-01）：
// - 恢复执行需要三个闸门全部就绪：
//   1. 写入/同步闸门：恢复期间冻结目标公司数据区的写入与同步；
//   2. 失败回滚补偿：恢复中途失败能回到保护副本；
//   3. 受保护包解密材料可得；
// - 任一闸门未就绪即**如实不可用**，并给出受控原因码（前端按码映射文案）；
// - 不用"看起来可用"换体验：缺闸门就是不可用。

/** 恢复执行必须就绪的前置闸门 */
export const restoreExecutionGateValues = {
  /** 恢复期写入/同步闸门 */
  WRITE_GATE: 'WRITE_GATE',
  /** 失败回滚补偿 */
  FAILURE_COMPENSATION: 'FAILURE_COMPENSATION',
  /** 受保护包解密材料 */
  PROTECTION_KEY: 'PROTECTION_KEY',
} as const;

export type RestoreExecutionGate =
  (typeof restoreExecutionGateValues)[keyof typeof restoreExecutionGateValues];

/** 恢复执行能力的受控原因码（对外只给码，前端按码映射文案） */
export const restoreExecutionCapabilityReasonCodeValues = {
  /** 三个闸门都就绪 */
  AVAILABLE: 'RESTORE_EXECUTION_AVAILABLE',
  /** 写入/同步闸门未就绪 */
  WRITE_GATE_UNAVAILABLE: 'RESTORE_WRITE_GATE_UNAVAILABLE',
  /** 失败回滚补偿未就绪 */
  FAILURE_COMPENSATION_UNAVAILABLE: 'RESTORE_FAILURE_COMPENSATION_UNAVAILABLE',
  /** 受保护包解密材料不可得 */
  PROTECTION_KEY_UNAVAILABLE: 'RESTORE_PROTECTION_KEY_UNAVAILABLE',
} as const;

export type RestoreExecutionCapabilityReasonCode =
  (typeof restoreExecutionCapabilityReasonCodeValues)[keyof typeof restoreExecutionCapabilityReasonCodeValues];

/** 恢复执行的闸门事实（由用例层从真实能力实现取） */
export type RestoreExecutionCapabilityFacts = {
  /** 写入/同步闸门是否就绪 */
  writeGateReady: boolean;
  /** 失败回滚补偿是否就绪 */
  failureCompensationReady: boolean;
  /** 受保护包解密材料是否可得 */
  protectionKeyReady: boolean;
};

export type RestoreExecutionCapabilityOutcome = {
  /** 是否可执行恢复 */
  executionAvailable: boolean;
  /** 受控原因码（始终有值：可用时为 AVAILABLE） */
  reasonCode: RestoreExecutionCapabilityReasonCode;
  /** 未就绪的闸门（可用时为空） */
  missingGates: RestoreExecutionGate[];
};

/** 闸门缺失 → 原因码（按固定优先级取第一个，作为对外展示的主因） */
const GATE_REASON_CODES: Record<RestoreExecutionGate, RestoreExecutionCapabilityReasonCode> = {
  WRITE_GATE: restoreExecutionCapabilityReasonCodeValues.WRITE_GATE_UNAVAILABLE,
  FAILURE_COMPENSATION: restoreExecutionCapabilityReasonCodeValues.FAILURE_COMPENSATION_UNAVAILABLE,
  PROTECTION_KEY: restoreExecutionCapabilityReasonCodeValues.PROTECTION_KEY_UNAVAILABLE,
};

/**
 * 裁决恢复执行能力。
 *
 * 全部门禁就绪才返回可用；否则按固定优先级给出主因原因码，并保留全部缺失闸门。
 */
export function resolveRestoreExecutionCapability(
  facts: RestoreExecutionCapabilityFacts,
): RestoreExecutionCapabilityOutcome {
  const missingGates: RestoreExecutionGate[] = [];
  if (!facts.writeGateReady) {
    missingGates.push(restoreExecutionGateValues.WRITE_GATE);
  }
  if (!facts.failureCompensationReady) {
    missingGates.push(restoreExecutionGateValues.FAILURE_COMPENSATION);
  }
  if (!facts.protectionKeyReady) {
    missingGates.push(restoreExecutionGateValues.PROTECTION_KEY);
  }
  if (missingGates.length === 0) {
    return {
      executionAvailable: true,
      reasonCode: restoreExecutionCapabilityReasonCodeValues.AVAILABLE,
      missingGates: [],
    };
  }
  const primary = missingGates[0];
  return {
    executionAvailable: false,
    reasonCode: GATE_REASON_CODES[primary],
    missingGates,
  };
}
