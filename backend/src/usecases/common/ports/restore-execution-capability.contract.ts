// src/usecases/common/ports/restore-execution-capability.contract.ts

/**
 * 恢复执行能力探测契约（任务 09 S4；review M11）。
 *
 * 归属：usecase 共享运行时能力（`src/usecases/common/ports/`）。
 * 事实来源：真正实现了恢复期写入/同步闸门与失败回滚补偿的运行时实现。
 * 未装配实现时用例按"闸门全部未就绪"如实处理——不猜、不硬编码可用。
 */
export const RESTORE_EXECUTION_CAPABILITY = Symbol('RESTORE_EXECUTION_CAPABILITY');

/** 恢复执行闸门报告（实现方如实回答，不做推断） */
export type RestoreExecutionCapabilityReport = {
  /** 恢复期写入/同步闸门是否就绪 */
  writeGateReady: boolean;
  /** 失败回滚补偿是否就绪 */
  failureCompensationReady: boolean;
  /** 受保护包解密材料是否可得 */
  protectionKeyReady: boolean;
};

export type RestoreExecutionCapabilityProbe = {
  probe(): Promise<RestoreExecutionCapabilityReport>;
};
