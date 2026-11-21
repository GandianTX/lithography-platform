// src/modules/ai-workflow-context/ai-workflow-context.types.ts
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { RECORD_SOURCES, type RecordSource } from '@app-types/common/record-source.types';

export const AI_WORKFLOW_CONTEXT_PAYLOAD_MAX_BYTES = 1024 * 1024;

export const AI_WORKFLOW_CONTEXT_STATUSES = [
  'CREATED',
  'ADMISSION_WAITING',
  'QUEUED',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;

export type AiWorkflowContextStatus = (typeof AI_WORKFLOW_CONTEXT_STATUSES)[number];

export const AI_WORKFLOW_CONTEXT_TERMINAL_STATUSES = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const satisfies readonly AiWorkflowContextStatus[];

export type AiWorkflowContextTerminalStatus =
  (typeof AI_WORKFLOW_CONTEXT_TERMINAL_STATUSES)[number];

export const AI_WORKFLOW_CONTEXT_ACTIVE_STATUSES = [
  'CREATED',
  'ADMISSION_WAITING',
  'QUEUED',
  'PROCESSING',
] as const satisfies readonly AiWorkflowContextStatus[];

export const AI_WORKFLOW_CONTEXT_SOURCES = RECORD_SOURCES;
export type AiWorkflowContextSource = RecordSource;

export const AI_WORKFLOW_ASYNC_TASK_BIZ_TYPE = 'ai_workflow';

export type AiWorkflowJsonPrimitive = string | number | boolean | null;
export type AiWorkflowJsonObject = {
  readonly [key: string]: AiWorkflowJsonValue;
};
export type AiWorkflowJsonArray = readonly AiWorkflowJsonValue[];
export type AiWorkflowJsonValue =
  AiWorkflowJsonPrimitive | AiWorkflowJsonObject | AiWorkflowJsonArray;
export type AiWorkflowJsonPayload =
  Exclude<AiWorkflowJsonPrimitive, null> | AiWorkflowJsonObject | AiWorkflowJsonArray;

export interface AiWorkflowContextView {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly workflowDedupHash: Buffer | null;
  readonly workflowDedupActiveHash: Buffer | null;
  readonly traceId: string;
  readonly queueName: string | null;
  readonly jobName: string | null;
  readonly jobId: string | null;
  readonly asyncTaskRecordId: number | null;
  readonly bizType: string;
  readonly bizKey: string;
  readonly bizSubKey: string | null;
  readonly source: AiWorkflowContextSource;
  readonly actorAccountId: number | null;
  readonly actorActiveRole: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly status: AiWorkflowContextStatus;
  readonly inputPayloadJson: AiWorkflowJsonPayload;
  readonly outputPayloadJson: AiWorkflowJsonPayload | null;
  readonly admissionAttemptCount: number;
  readonly nextEnqueueAt: Date | null;
  readonly admissionExpiresAt: Date | null;
  readonly admissionReason: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AiWorkflowContextHousekeepingCandidate {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly traceId: string;
  readonly queueName: string | null;
  readonly jobName: string | null;
  readonly jobId: string | null;
  readonly asyncTaskRecordId: number | null;
  readonly bizType: string;
  readonly bizKey: string;
  readonly bizSubKey: string | null;
  readonly source: AiWorkflowContextSource;
  readonly actorAccountId: number | null;
  readonly actorActiveRole: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly status: AiWorkflowContextStatus;
  readonly nextEnqueueAt: Date | null;
  readonly admissionExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * 受理事务内的待准入事实（任务05 Q01／B2）。
 *
 * 传了就表示「本次创建即为已受理、等待投递」，由 housekeeping 按 `nextEnqueueAt` 真正处理；
 * 只创建 `CREATED` 不会被现有恢复器扫描，因此受理侧必须用这一项落下可恢复事实。
 */
export interface AiWorkflowContextAdmissionPlan {
  /** 到期投递时间；等于受理时刻表示「提交后立即可投递」 */
  readonly nextEnqueueAt: Date;
  /** 准入截止时间；过期后不再自动投递 */
  readonly admissionExpiresAt: Date;
  /** 受控原因码（如 `ACCEPTED_IN_TRANSACTION`、`QUEUE_UNAVAILABLE`） */
  readonly admissionReason: string;
}

export interface CreateAiWorkflowContextInput {
  readonly workflowType: string;
  readonly workflowDedupKey?: string | null;
  readonly inputPayload: AiWorkflowJsonPayload;
  readonly traceId?: string | null;
  readonly bizType: string;
  readonly bizKey: string;
  readonly bizSubKey?: string | null;
  readonly source: AiWorkflowContextSource;
  readonly actorAccountId?: number | null;
  readonly actorActiveRole?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly transactionContext?: PersistenceTransactionContext;
  readonly admission?: AiWorkflowContextAdmissionPlan | null;
}

export type CreateAiWorkflowContextResult =
  | {
      readonly status: 'CREATED';
      readonly context: AiWorkflowContextView;
    }
  | {
      readonly status: 'EXISTING_ACTIVE';
      readonly context: AiWorkflowContextView;
    };

export type AiWorkflowPayloadReadResult =
  | {
      readonly kind: 'PRESENT';
      readonly payload: AiWorkflowJsonPayload;
    }
  | {
      readonly kind: 'NONE';
    };

export type AiWorkflowContextMutationResult =
  | {
      readonly status: 'UPDATED';
      readonly context: AiWorkflowContextView;
    }
  | {
      readonly status: 'CONFLICT';
      readonly context: AiWorkflowContextView | null;
    };

export interface WriteAiWorkflowOutputPayloadInput {
  readonly workflowId: string;
  readonly outputPayload: AiWorkflowJsonPayload;
  readonly expectedStatuses: readonly AiWorkflowContextStatus[];
  readonly transactionContext?: PersistenceTransactionContext;
}

export interface WriteAiWorkflowOutputPayloadForWorkerInput extends WriteAiWorkflowOutputPayloadInput {
  readonly jobId: string;
}

export interface MarkAiWorkflowAdmissionWaitingInput {
  readonly workflowId: string;
  readonly expectedStatuses: readonly AiWorkflowContextStatus[];
  readonly nextEnqueueAt: Date;
  readonly admissionExpiresAt: Date;
  readonly admissionReason: string;
  readonly transactionContext?: PersistenceTransactionContext;
}

export interface MarkAiWorkflowQueuedForAdmissionInput {
  readonly workflowId: string;
  readonly queueName: string;
  readonly jobName: string;
  readonly jobId: string;
  readonly admissionExpiresAt: Date;
  readonly now: Date;
  readonly transactionContext?: PersistenceTransactionContext;
}

export interface LinkAiWorkflowAsyncTaskRecordInput {
  readonly workflowId: string;
  readonly jobId: string;
  readonly asyncTaskRecordId: number;
  readonly expectedStatuses: readonly AiWorkflowContextStatus[];
  readonly transactionContext?: PersistenceTransactionContext;
}

export interface LinkAiWorkflowTerminalAsyncTaskRecordInput {
  readonly workflowId: string;
  readonly jobId: string;
  readonly asyncTaskRecordId: number;
  readonly expectedStatuses: readonly AiWorkflowContextTerminalStatus[];
  readonly transactionContext?: PersistenceTransactionContext;
}

export interface MarkAiWorkflowProcessingForWorkerInput {
  readonly workflowId: string;
  readonly jobId: string;
  readonly now: Date;
  readonly processingTimeoutMs: number;
  readonly transactionContext?: PersistenceTransactionContext;
}

export interface ReleaseAiWorkflowProcessingForRetryInput {
  readonly workflowId: string;
  readonly jobId: string;
  readonly transactionContext?: PersistenceTransactionContext;
}

export interface MarkAiWorkflowSucceededForWorkerInput {
  readonly workflowId: string;
  readonly jobId: string;
  readonly transactionContext?: PersistenceTransactionContext;
}

export interface MarkAiWorkflowFailedForWorkerInput {
  readonly workflowId: string;
  readonly jobId: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly transactionContext?: PersistenceTransactionContext;
}

export interface MarkAiWorkflowSucceededInput {
  readonly workflowId: string;
  readonly expectedStatuses: readonly AiWorkflowContextStatus[];
  readonly transactionContext?: PersistenceTransactionContext;
}

export interface MarkAiWorkflowFailedInput {
  readonly workflowId: string;
  readonly expectedStatuses: readonly AiWorkflowContextStatus[];
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly transactionContext?: PersistenceTransactionContext;
}

export interface MarkAiWorkflowCancelledInput {
  readonly workflowId: string;
  readonly expectedStatuses: readonly AiWorkflowContextStatus[];
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  readonly transactionContext?: PersistenceTransactionContext;
}

export interface ListAiWorkflowDueAdmissionWaitingInput {
  readonly now: Date;
  readonly limit: number;
  readonly transactionContext?: PersistenceTransactionContext;
}

export interface ListAiWorkflowStaleQueuedInput {
  readonly staleBefore: Date;
  readonly limit: number;
  readonly transactionContext?: PersistenceTransactionContext;
}

export interface ListAiWorkflowTerminalContextsInput {
  readonly limit: number;
  readonly transactionContext?: PersistenceTransactionContext;
}
