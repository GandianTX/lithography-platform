// src/usecases/intake-analysis/intake-analysis-worker.types.ts
// 首析 Worker 用例的显式输入/输出契约（不感知 BullMQ runtime 对象）。

export interface ConsumeIntakeAnalysisJobProcessInput {
  readonly queueName: string;
  readonly jobName: string;
  readonly jobId: string;
  readonly traceId: string;
  readonly intakeId: number;
  readonly generationNo: number;
  readonly attemptsMade: number;
  readonly maxAttempts?: number;
  readonly startedAt?: Date;
  readonly enqueuedAt?: Date;
}

export interface ConsumeIntakeAnalysisJobProcessResult {
  readonly accepted: boolean;
  readonly intakeId: number;
  readonly generationNo: number;
}

export interface ConsumeIntakeAnalysisJobCompleteInput {
  readonly queueName: string;
  readonly jobName: string;
  readonly jobId: string;
  readonly traceId: string;
  readonly attemptsMade: number;
  readonly maxAttempts?: number;
  readonly startedAt?: Date;
  readonly finishedAt?: Date;
  readonly enqueuedAt?: Date;
}

export interface ConsumeIntakeAnalysisJobFailInput {
  readonly queueName: string;
  readonly jobName: string;
  readonly jobId: string;
  readonly traceId: string;
  readonly attemptsMade: number;
  readonly maxAttempts?: number;
  readonly startedAt?: Date;
  readonly finishedAt?: Date;
  readonly occurredAt?: Date;
  readonly enqueuedAt?: Date;
  readonly reason?: string;
  /**
   * adapter 把「不可重试错误」翻译成的稳定错误码（未分类时为 null/缺省）。
   * usecase 据此区分受控终结与可补投的临时故障，不感知 BullMQ 错误类型。
   */
  readonly nonRetryableCode?: string | null;
}
