// src/usecases/intake-analysis/intake-analysis-housekeeping.types.ts
// housekeeping 阶段结果的共享流程类型（usecase 与 adapter spec 共用）。
//
// 计数语义：
// - redelivered：真实补投（状态感知，只有在途检查通过后才产生）
// - reconciled：账本按业务真实结果收敛终态（写回已完成、账本未终结的崩溃窗口）
// - parked：永久错误受控终结（需人工处置，不再参与补投）
// - cancelled：不可执行意图取消（已删除原稿 / 代次切换 / 未关联工单）
// - skipped：本轮主动不改写（在途、租约有效、等待其他阶段处理）
// - failed：本行处理抛错（不改写任何状态，下一轮重试）

export interface IntakeAnalysisHousekeepingPhaseResult {
  readonly scanned: number;
  readonly redelivered: number;
  readonly reconciled: number;
  readonly parked: number;
  readonly cancelled: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface IntakeAnalysisHousekeepingResult {
  readonly redeliverStaleQueued: IntakeAnalysisHousekeepingPhaseResult;
  readonly recoverStaleProcessing: IntakeAnalysisHousekeepingPhaseResult;
  readonly cancelOrphanedIntents: IntakeAnalysisHousekeepingPhaseResult;
}
