// src/usecases/repair-request/deliver-intake-analysis.types.ts
// 首析投递（报修域）的显式输入/输出契约。

export interface DeliverIntakeAnalysisInput {
  readonly intakeId: number;
  readonly generationNo: number;
  readonly traceId: string;
}

export interface DeliverIntakeAnalysisResult {
  /** false = 入队失败或能力被禁用；账本行仍为 queued，由 housekeeping 补投 */
  readonly delivered: boolean;
  readonly jobId: string;
  readonly traceId: string;
}
