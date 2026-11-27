// src/usecases/local-runtime/get-local-restore-capability.usecase.spec.ts
// 恢复执行能力查询用例单测（任务 09 S4；review M11）。
//
// 口径：裁决在 core，事实来自真实能力实现；未装配或探测失败都如实不可用。

import { GetLocalRestoreCapabilityUsecase } from './get-local-restore-capability.usecase';

describe('get local restore capability usecase', () => {
  it('未装配恢复执行能力实现时如实不可用', async () => {
    const usecase = new GetLocalRestoreCapabilityUsecase(undefined);

    const result = await usecase.execute();

    expect(result.executionAvailable).toBe(false);
    expect(result.reasonCode).toBe('RESTORE_WRITE_GATE_UNAVAILABLE');
    expect(result.missingGates).toEqual(['WRITE_GATE', 'FAILURE_COMPENSATION', 'PROTECTION_KEY']);
  });

  it('能力实现如实报告闸门就绪时判定可执行恢复', async () => {
    const usecase = new GetLocalRestoreCapabilityUsecase({
      probe: () =>
        Promise.resolve({
          writeGateReady: true,
          failureCompensationReady: true,
          protectionKeyReady: true,
        }),
    });

    const result = await usecase.execute();

    expect(result.executionAvailable).toBe(true);
    expect(result.reasonCode).toBe('RESTORE_EXECUTION_AVAILABLE');
  });

  it('探测异常时按未就绪处理，不把不可用说成可用', async () => {
    const usecase = new GetLocalRestoreCapabilityUsecase({
      probe: () => Promise.reject(new Error('probe failed')),
    });

    const result = await usecase.execute();

    expect(result.executionAvailable).toBe(false);
    expect(result.reasonCode).toBe('RESTORE_WRITE_GATE_UNAVAILABLE');
  });
});
