// src/core/local-runtime/policy/restore-execution-capability.policy.spec.ts
// 恢复执行能力裁决单测（任务 09 S4；review M11）。
//
// 口径：三个闸门全部就绪才可执行恢复；缺任一闸门即如实不可用并给出受控原因码。

import {
  resolveRestoreExecutionCapability,
  restoreExecutionCapabilityReasonCodeValues,
  type RestoreExecutionCapabilityFacts,
} from './restore-execution-capability.policy';

describe('restore execution capability policy', () => {
  const ready: RestoreExecutionCapabilityFacts = {
    writeGateReady: true,
    failureCompensationReady: true,
    protectionKeyReady: true,
  };

  it('三个闸门全部就绪时可执行恢复', () => {
    const outcome = resolveRestoreExecutionCapability(ready);

    expect(outcome.executionAvailable).toBe(true);
    expect(outcome.reasonCode).toBe(restoreExecutionCapabilityReasonCodeValues.AVAILABLE);
    expect(outcome.missingGates).toHaveLength(0);
  });

  it('缺写入/同步闸门时不可用并给出对应原因码', () => {
    const outcome = resolveRestoreExecutionCapability({
      ...ready,
      writeGateReady: false,
    });

    expect(outcome.executionAvailable).toBe(false);
    expect(outcome.reasonCode).toBe(
      restoreExecutionCapabilityReasonCodeValues.WRITE_GATE_UNAVAILABLE,
    );
    expect(outcome.missingGates).toEqual(['WRITE_GATE']);
  });

  it('缺失败回滚补偿时不可用并给出对应原因码', () => {
    const outcome = resolveRestoreExecutionCapability({
      ...ready,
      failureCompensationReady: false,
    });

    expect(outcome.executionAvailable).toBe(false);
    expect(outcome.reasonCode).toBe(
      restoreExecutionCapabilityReasonCodeValues.FAILURE_COMPENSATION_UNAVAILABLE,
    );
  });

  it('缺受保护包解密材料时不可用并给出对应原因码', () => {
    const outcome = resolveRestoreExecutionCapability({
      ...ready,
      protectionKeyReady: false,
    });

    expect(outcome.executionAvailable).toBe(false);
    expect(outcome.reasonCode).toBe(
      restoreExecutionCapabilityReasonCodeValues.PROTECTION_KEY_UNAVAILABLE,
    );
  });

  it('多个闸门缺失时按固定优先级给出主因，并保留全部缺失闸门', () => {
    const outcome = resolveRestoreExecutionCapability({
      writeGateReady: false,
      failureCompensationReady: false,
      protectionKeyReady: false,
    });

    expect(outcome.executionAvailable).toBe(false);
    expect(outcome.reasonCode).toBe(
      restoreExecutionCapabilityReasonCodeValues.WRITE_GATE_UNAVAILABLE,
    );
    expect(outcome.missingGates).toEqual(['WRITE_GATE', 'FAILURE_COMPENSATION', 'PROTECTION_KEY']);
  });
});
