// src/infrastructure/bullmq/contracts/intake-analysis-queue.runtime.ts
// intake-analysis 队列的 job 契约（任务 03 首次 AI 分析投递）。
//
// payload 只携带业务定位键（intakeId + generationNo）与 traceId，
// 不携带报修正文：Worker 从 repair_request_intake 读取保存时的原稿事实，
// 队列 payload 不成为第二个事实来源。
//
// jobId 由调用方确定为 `intake-analysis:{intakeId}:g{generationNo}`
// （见 src/core/common/async-task/intake-analysis-job-id.policy.ts），
// BullMQ 同 jobId add 幂等；generation 变化产生新 jobId，不互相覆盖。

import { BULLMQ_JOBS, BULLMQ_QUEUES } from '../bullmq.constants';
import { isNonEmptyString, isRecord } from './shared-payload-validators';

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export interface IntakeAnalysisJobPayload {
  readonly intakeId: number;
  readonly generationNo: number;
  readonly traceId?: string;
}

export interface IntakeAnalysisJobResult {
  readonly accepted: boolean;
  readonly intakeId: number;
  readonly generationNo: number;
}

const isIntakeAnalysisJobPayload = (payload: unknown): payload is IntakeAnalysisJobPayload => {
  if (!isRecord(payload)) return false;
  return (
    isPositiveInteger(payload.intakeId) &&
    (payload.generationNo === 0 || payload.generationNo === 1) &&
    (payload.traceId === undefined || isNonEmptyString(payload.traceId))
  );
};

const isIntakeAnalysisJobResult = (result: unknown): result is IntakeAnalysisJobResult => {
  if (!isRecord(result)) return false;
  return (
    typeof result.accepted === 'boolean' &&
    isPositiveInteger(result.intakeId) &&
    (result.generationNo === 0 || result.generationNo === 1)
  );
};

export const INTAKE_ANALYSIS_JOB_CONTRACT = {
  [BULLMQ_JOBS.INTAKE_ANALYSIS.ANALYZE]: {
    payload: {} as IntakeAnalysisJobPayload,
    result: {} as IntakeAnalysisJobResult,
    payloadValidator: isIntakeAnalysisJobPayload,
    resultValidator: isIntakeAnalysisJobResult,
  },
} as const;

export const INTAKE_ANALYSIS_QUEUE_CONTRACT = {
  queueName: BULLMQ_QUEUES.INTAKE_ANALYSIS,
  jobs: INTAKE_ANALYSIS_JOB_CONTRACT,
} as const;
