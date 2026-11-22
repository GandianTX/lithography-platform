// src/usecases/local-runtime/get-local-restore-capability.usecase.ts

import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  resolveRestoreExecutionCapability,
  type RestoreExecutionCapabilityReasonCode,
} from '@core/local-runtime/policy/restore-execution-capability.policy';
import {
  RESTORE_EXECUTION_CAPABILITY,
  type RestoreExecutionCapabilityProbe,
} from '@src/usecases/common/ports/restore-execution-capability.contract';

/**
 * 恢复执行能力查询用例（任务 09 S4；review M11）。
 *
 * 职责边界：
 * - 裁决在 core：能不能执行恢复由 resolveRestoreExecutionCapability 判定，
 *   adapter 不再硬编码 executionAvailable: false；
 * - 事实来自真实能力实现：写入/同步闸门、失败回滚补偿与受保护包解密材料是否就绪，
 *   由实现了这些能力的运行时实现如实回答；
 * - 未装配即不可用：没有装配能力实现时按"闸门全部未就绪"如实表达，
 *   不猜、不乐观、也不用"看起来可用"换体验；
 * - 本用例无副作用：不写库、不动文件、不触发恢复。
 */

export type LocalRestoreCapabilityResult = {
  /** 恢复执行入口是否可用 */
  executionAvailable: boolean;
  /** 受控原因码（前端按码映射文案） */
  reasonCode: RestoreExecutionCapabilityReasonCode;
  /** 未就绪的闸门 */
  missingGates: string[];
};

@Injectable()
export class GetLocalRestoreCapabilityUsecase {
  constructor(
    @Optional()
    @Inject(RESTORE_EXECUTION_CAPABILITY)
    private readonly probe: RestoreExecutionCapabilityProbe | undefined,
  ) {}

  async execute(): Promise<LocalRestoreCapabilityResult> {
    const report = await this.readReport();
    const outcome = resolveRestoreExecutionCapability(report);
    return {
      executionAvailable: outcome.executionAvailable,
      reasonCode: outcome.reasonCode,
      missingGates: outcome.missingGates,
    };
  }

  /**
   * 读取闸门事实。
   *
   * 未装配能力实现时三项都未就绪；探测失败时同样按未就绪处理，
   * 不因探测异常把"不可用"说成"可用"。
   */
  private async readReport(): Promise<{
    writeGateReady: boolean;
    failureCompensationReady: boolean;
    protectionKeyReady: boolean;
  }> {
    if (!this.probe) {
      return {
        writeGateReady: false,
        failureCompensationReady: false,
        protectionKeyReady: false,
      };
    }
    try {
      return await this.probe.probe();
    } catch {
      return {
        writeGateReady: false,
        failureCompensationReady: false,
        protectionKeyReady: false,
      };
    }
  }
}
