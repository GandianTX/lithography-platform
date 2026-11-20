// src/adapters/worker/intake-analysis/intake-analysis-job.mapper.ts
// 协议适配：BullMQ Job ↔ 显式 usecase 输入；不承载业务规则。

import { isIntakeAnalysisNonRetryableError } from '@src/usecases/intake-analysis/intake-analysis-worker.errors';
import type {
  ConsumeIntakeAnalysisJobCompleteInput,
  ConsumeIntakeAnalysisJobFailInput,
  ConsumeIntakeAnalysisJobProcessInput,
} from '@src/usecases/intake-analysis/intake-analysis-worker.types';
import type { Job } from 'bullmq';

export const INTAKE_ANALYSIS_ADAPTER_QUEUE_NAME = 'intake-analysis';
export const INTAKE_ANALYSIS_ADAPTER_JOB_NAME = 'analyze';

export interface IntakeAnalysisJobPayloadView {
  readonly intakeId: number;
  readonly generationNo: number;
  readonly traceId?: string;
}

export type IntakeAnalysisJobResultView = {
  readonly accepted: boolean;
  readonly intakeId: number;
  readonly generationNo: number;
};

export type IntakeAnalysisJob = Job<
  IntakeAnalysisJobPayloadView,
  IntakeAnalysisJobResultView,
  typeof INTAKE_ANALYSIS_ADAPTER_JOB_NAME
>;
export type IntakeAnalysisFailedJob = Job<Record<string, unknown>, unknown, string>;

export function mapIntakeAnalysisJobToProcessInput(params: {
  readonly job: IntakeAnalysisJob;
}): ConsumeIntakeAnalysisJobProcessInput {
  const job = params.job;
  const payload = job.data;
  return {
    queueName: INTAKE_ANALYSIS_ADAPTER_QUEUE_NAME,
    jobName: job.name,
    jobId: String(job.id ?? ''),
    traceId: payload.traceId ?? String(job.id ?? ''),
    intakeId: Number(payload.intakeId),
    generationNo: Number(payload.generationNo),
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts.attempts,
    startedAt: job.processedOn ? new Date(job.processedOn) : undefined,
    enqueuedAt: job.timestamp ? new Date(job.timestamp) : undefined,
  };
}

export function mapIntakeAnalysisJobToCompleteInput(params: {
  readonly job: IntakeAnalysisJob;
}): ConsumeIntakeAnalysisJobCompleteInput {
  const job = params.job;
  const payload = job.data;
  return {
    queueName: INTAKE_ANALYSIS_ADAPTER_QUEUE_NAME,
    jobName: job.name,
    jobId: String(job.id ?? ''),
    traceId: payload.traceId ?? String(job.id ?? ''),
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts.attempts,
    startedAt: job.processedOn ? new Date(job.processedOn) : undefined,
    finishedAt: job.finishedOn ? new Date(job.finishedOn) : undefined,
    enqueuedAt: job.timestamp ? new Date(job.timestamp) : undefined,
  };
}

export function mapIntakeAnalysisJobToFailInput(params: {
  readonly job: IntakeAnalysisJob;
  readonly error: Error;
}): ConsumeIntakeAnalysisJobFailInput {
  const job = params.job;
  const payload = job.data;
  return {
    queueName: INTAKE_ANALYSIS_ADAPTER_QUEUE_NAME,
    jobName: job.name,
    jobId: String(job.id ?? ''),
    traceId: payload.traceId ?? String(job.id ?? ''),
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts.attempts,
    startedAt: job.processedOn ? new Date(job.processedOn) : undefined,
    finishedAt: new Date(),
    occurredAt: new Date(),
    enqueuedAt: job.timestamp ? new Date(job.timestamp) : undefined,
    reason: params.error.message,
    // 不可重试语义在此翻译成稳定错误码，usecase 不感知 BullMQ 错误类型
    nonRetryableCode: isIntakeAnalysisNonRetryableError(params.error) ? params.error.code : null,
  };
}

/** 降级上下文：job 缺失时仍可执行 fail（worker-usecase 规则） */
export function mapMissingIntakeAnalysisJobToFailInput(params: {
  readonly error: Error;
}): ConsumeIntakeAnalysisJobFailInput {
  return {
    queueName: INTAKE_ANALYSIS_ADAPTER_QUEUE_NAME,
    jobName: INTAKE_ANALYSIS_ADAPTER_JOB_NAME,
    jobId: `missing:${Date.now()}`,
    traceId: `degraded:intake-analysis:${Date.now()}`,
    attemptsMade: 0,
    occurredAt: new Date(),
    finishedAt: new Date(),
    reason: `missing_job:${params.error.message.slice(0, 80)}`,
  };
}
