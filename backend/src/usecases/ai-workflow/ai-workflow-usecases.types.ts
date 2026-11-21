import type {
  AiWorkflowContextView,
  CreateAiWorkflowContextInput,
} from '@src/modules/ai-workflow-context/ai-workflow-context.types';
export { AI_WORKFLOW_ASYNC_TASK_BIZ_TYPE } from '@src/modules/ai-workflow-context/ai-workflow-context.types';
export {
  AI_WORKFLOW_JOB_NAME,
  AI_WORKFLOW_QUEUE_NAME,
} from '@src/modules/ai-workflow-context/queue/ai-workflow-queue.constants';

export const AI_WORKFLOW_ADMISSION_RETRY_DELAY_MS = 30 * 1000;
export const AI_WORKFLOW_ADMISSION_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** 受理事务内准备的待准入事实原因码（任务05 Q01） */
export const AI_WORKFLOW_ADMISSION_REASON_ACCEPTED = 'ACCEPTED_IN_TRANSACTION';
export const AI_WORKFLOW_HOUSEKEEPING_DEFAULT_BATCH_LIMIT = 50;
export const AI_WORKFLOW_HOUSEKEEPING_DEFAULT_STALE_QUEUED_GRACE_MS = 60 * 1000;

export type CreateAndAdmitAiWorkflowInput = Omit<
  CreateAiWorkflowContextInput,
  'transactionContext'
>;

export type CreateAndAdmitAiWorkflowResult =
  | {
      readonly status: 'QUEUED';
      readonly context: AiWorkflowContextView;
      readonly jobId: string;
      readonly traceId: string;
      readonly asyncTaskRecordId: number;
    }
  | {
      readonly status: 'ADMISSION_WAITING';
      readonly context: AiWorkflowContextView;
      readonly reason: 'QUEUE_UNAVAILABLE';
    }
  | {
      readonly status: 'EXISTING_ACTIVE';
      readonly context: AiWorkflowContextView;
    }
  | {
      readonly status: 'STALE_QUEUED';
      readonly context: AiWorkflowContextView;
      readonly jobId: string;
      readonly traceId: string;
      readonly reason: 'ENQUEUE_FAILED' | 'POST_ENQUEUE_BACKFILL_FAILED';
    }
  | {
      readonly status: 'CONFLICT';
      readonly context: AiWorkflowContextView | null;
    };

export interface RunAiWorkflowHousekeepingInput {
  readonly now?: Date;
  readonly limit?: number;
  readonly staleQueuedGraceMs?: number;
}

export interface AiWorkflowHousekeepingPhaseResult {
  readonly scanned: number;
  readonly succeeded: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface RunAiWorkflowHousekeepingResult {
  readonly admission: AiWorkflowHousekeepingPhaseResult;
  readonly staleQueued: AiWorkflowHousekeepingPhaseResult;
  readonly asyncTaskReconcile: AiWorkflowHousekeepingPhaseResult;
}
