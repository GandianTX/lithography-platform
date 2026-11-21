import { randomUUID } from 'node:crypto';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Inject, Injectable } from '@nestjs/common';
import { resolveAsyncTaskBizKey } from '@src/core/common/async-task/async-task-identifier.policy';
import { normalizeOptionalText } from '@src/core/common/input-normalize/input-normalize.policy';
import { AiWorkflowContextService } from '@src/modules/ai-workflow-context/ai-workflow-context.service';
import type {
  AiWorkflowContextMutationResult,
  AiWorkflowContextView,
} from '@src/modules/ai-workflow-context/ai-workflow-context.types';
import { AiWorkflowQueueService } from '@src/modules/ai-workflow-context/queue/ai-workflow-queue.service';
import { AsyncTaskRecordService } from '@src/modules/async-task-record/async-task-record.service';
import type { AsyncTaskRecordView } from '@src/modules/async-task-record/async-task-record.types';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { PinoLogger } from 'nestjs-pino';
import {
  AI_WORKFLOW_ADMISSION_REASON_ACCEPTED,
  AI_WORKFLOW_ADMISSION_RETRY_DELAY_MS,
  AI_WORKFLOW_ADMISSION_TIMEOUT_MS,
  AI_WORKFLOW_ASYNC_TASK_BIZ_TYPE,
  AI_WORKFLOW_JOB_NAME,
  AI_WORKFLOW_QUEUE_NAME,
  type CreateAndAdmitAiWorkflowInput,
  type CreateAndAdmitAiWorkflowResult,
} from './ai-workflow-usecases.types';

@Injectable()
export class CreateAndAdmitAiWorkflowUsecase {
  constructor(
    private readonly aiWorkflowContextService: AiWorkflowContextService,
    private readonly aiWorkflowQueueService: AiWorkflowQueueService,
    private readonly asyncTaskRecordService: AsyncTaskRecordService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CreateAndAdmitAiWorkflowUsecase.name);
  }

  async execute(input: CreateAndAdmitAiWorkflowInput): Promise<CreateAndAdmitAiWorkflowResult> {
    const createResult = await this.transactionRunner.run(async (transactionContext) =>
      this.aiWorkflowContextService.createContext({
        ...input,
        transactionContext,
      }),
    );
    const now = new Date();
    if (
      createResult.status === 'EXISTING_ACTIVE' &&
      !this.shouldAttemptAdmission({ context: createResult.context, now })
    ) {
      return {
        status: 'EXISTING_ACTIVE',
        context: createResult.context,
      };
    }

    return await this.admitContext({
      context: createResult.context,
      now,
    });
  }

  /**
   * 在调用方事务内准备「已受理、待投递」的上下文（任务05 Q01／B2）。
   *
   * 不调用队列、不写 Redis：只落一条现有 housekeeping 会扫描的
   * `ADMISSION_WAITING` ＋ 到期时间，因此受理事务回滚时不会残留执行事实，
   * 事务提交后即使进程退出也能被正式调度恢复。
   */
  async prepareInTransaction(
    input: CreateAndAdmitAiWorkflowInput,
    transactionContext: PersistenceTransactionContext,
  ): Promise<{ readonly status: 'PREPARED' | 'EXISTING_ACTIVE'; readonly workflowId: string }> {
    const now = new Date();
    const createResult = await this.aiWorkflowContextService.createContext({
      ...input,
      transactionContext,
      admission: {
        nextEnqueueAt: now,
        admissionExpiresAt: new Date(now.getTime() + AI_WORKFLOW_ADMISSION_TIMEOUT_MS),
        admissionReason: AI_WORKFLOW_ADMISSION_REASON_ACCEPTED,
      },
    });
    return {
      status: createResult.status === 'EXISTING_ACTIVE' ? 'EXISTING_ACTIVE' : 'PREPARED',
      workflowId: createResult.context.workflowId,
    };
  }

  async admitExisting(input: {
    readonly workflowId: string;
    readonly now?: Date;
  }): Promise<CreateAndAdmitAiWorkflowResult> {
    const context = await this.aiWorkflowContextService.findByWorkflowId({
      workflowId: input.workflowId,
    });
    if (!context) {
      return {
        status: 'CONFLICT',
        context: null,
      };
    }

    const now = input.now ?? new Date();
    if (!this.shouldAttemptAdmission({ context, now })) {
      return {
        status: 'CONFLICT',
        context,
      };
    }
    return await this.admitContext({ context, now });
  }

  private async admitContext(input: {
    readonly context: AiWorkflowContextView;
    readonly now: Date;
  }): Promise<CreateAndAdmitAiWorkflowResult> {
    const health = await this.aiWorkflowQueueService.checkWorkflowQueueAvailable();
    if (!health.available) {
      return await this.markAdmissionWaiting({
        context: input.context,
        now: input.now,
      });
    }

    const jobId = this.createWorkflowJobId();
    const admissionExpiresAt = this.resolveAdmissionExpiresAt({
      context: input.context,
      now: input.now,
    });
    const queuedResult = await this.transactionRunner.run(async (transactionContext) =>
      this.aiWorkflowContextService.markQueuedForAdmission({
        workflowId: input.context.workflowId,
        queueName: AI_WORKFLOW_QUEUE_NAME,
        jobName: AI_WORKFLOW_JOB_NAME,
        jobId,
        admissionExpiresAt,
        now: input.now,
        transactionContext,
      }),
    );
    if (queuedResult.status === 'CONFLICT') {
      return {
        status: 'CONFLICT',
        context: queuedResult.context,
      };
    }

    try {
      await this.aiWorkflowQueueService.enqueueWorkflow({
        workflowId: queuedResult.context.workflowId,
        traceId: queuedResult.context.traceId,
        jobId,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          error: sanitizeErrorMessage(error),
          workflowId: queuedResult.context.workflowId,
          jobId,
          traceId: queuedResult.context.traceId,
          reason: 'ENQUEUE_FAILED',
        },
        'AI workflow enqueue failed after context queued',
      );
      return {
        status: 'STALE_QUEUED',
        context: queuedResult.context,
        jobId,
        traceId: queuedResult.context.traceId,
        reason: 'ENQUEUE_FAILED',
      };
    }

    let asyncTaskRecord: AsyncTaskRecordView;
    let linkedResult: AiWorkflowContextMutationResult;
    try {
      const enqueuedAt = new Date();
      asyncTaskRecord = await this.asyncTaskRecordService.recordEnqueued({
        data: {
          queueName: AI_WORKFLOW_QUEUE_NAME,
          jobName: AI_WORKFLOW_JOB_NAME,
          jobId,
          traceId: queuedResult.context.traceId,
          actorAccountId: queuedResult.context.actorAccountId,
          actorActiveRole: queuedResult.context.actorActiveRole,
          bizType: AI_WORKFLOW_ASYNC_TASK_BIZ_TYPE,
          bizKey: resolveAsyncTaskBizKey({
            domain: AI_WORKFLOW_ASYNC_TASK_BIZ_TYPE,
            traceId: queuedResult.context.traceId,
            jobId,
          }),
          source: queuedResult.context.source,
          reason: 'enqueue_accepted',
          occurredAt: enqueuedAt,
          enqueuedAt,
        },
      });
      linkedResult = await this.aiWorkflowContextService.linkAsyncTaskRecord({
        workflowId: queuedResult.context.workflowId,
        jobId,
        asyncTaskRecordId: asyncTaskRecord.id,
        expectedStatuses: ['QUEUED', 'PROCESSING'],
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          error: sanitizeErrorMessage(error),
          workflowId: queuedResult.context.workflowId,
          jobId,
          traceId: queuedResult.context.traceId,
          reason: 'POST_ENQUEUE_BACKFILL_FAILED',
        },
        'AI workflow post-enqueue backfill failed',
      );
      return {
        status: 'STALE_QUEUED',
        context: queuedResult.context,
        jobId,
        traceId: queuedResult.context.traceId,
        reason: 'POST_ENQUEUE_BACKFILL_FAILED',
      };
    }

    if (linkedResult.status === 'CONFLICT') {
      return {
        status: 'STALE_QUEUED',
        context: linkedResult.context ?? queuedResult.context,
        jobId,
        traceId: queuedResult.context.traceId,
        reason: 'POST_ENQUEUE_BACKFILL_FAILED',
      };
    }

    return {
      status: 'QUEUED',
      context: linkedResult.context,
      jobId,
      traceId: queuedResult.context.traceId,
      asyncTaskRecordId: asyncTaskRecord.id,
    };
  }

  private async markAdmissionWaiting(input: {
    readonly context: AiWorkflowContextView;
    readonly now: Date;
  }): Promise<CreateAndAdmitAiWorkflowResult> {
    const result = await this.transactionRunner.run(async (transactionContext) =>
      this.aiWorkflowContextService.markAdmissionWaiting({
        workflowId: input.context.workflowId,
        expectedStatuses: [input.context.status],
        nextEnqueueAt: new Date(input.now.getTime() + AI_WORKFLOW_ADMISSION_RETRY_DELAY_MS),
        admissionExpiresAt: this.resolveAdmissionExpiresAt(input),
        admissionReason: 'QUEUE_UNAVAILABLE',
        transactionContext,
      }),
    );
    if (result.status === 'CONFLICT') {
      return {
        status: 'CONFLICT',
        context: result.context,
      };
    }
    return {
      status: 'ADMISSION_WAITING',
      context: result.context,
      reason: 'QUEUE_UNAVAILABLE',
    };
  }

  private shouldAttemptAdmission(input: {
    readonly context: AiWorkflowContextView;
    readonly now: Date;
  }): boolean {
    if (input.context.status === 'CREATED') {
      return !isExpired({ expiresAt: input.context.admissionExpiresAt, now: input.now });
    }
    if (input.context.status !== 'ADMISSION_WAITING') {
      return false;
    }
    if (isExpired({ expiresAt: input.context.admissionExpiresAt, now: input.now })) {
      return false;
    }
    return isDue({ dueAt: input.context.nextEnqueueAt, now: input.now });
  }

  private resolveAdmissionExpiresAt(input: {
    readonly context: AiWorkflowContextView;
    readonly now: Date;
  }): Date {
    return input.context.admissionExpiresAt
      ? new Date(input.context.admissionExpiresAt.getTime())
      : new Date(input.now.getTime() + AI_WORKFLOW_ADMISSION_TIMEOUT_MS);
  }

  private createWorkflowJobId(): string {
    return `aiw-${randomUUID()}`;
  }
}

function isExpired(input: { readonly expiresAt: Date | null; readonly now: Date }): boolean {
  return input.expiresAt !== null && input.expiresAt.getTime() <= input.now.getTime();
}

function isDue(input: { readonly dueAt: Date | null; readonly now: Date }): boolean {
  return input.dueAt !== null && input.dueAt.getTime() <= input.now.getTime();
}

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return (error.message || error.name || 'workflow_admission_error').slice(0, 256);
  }
  if (typeof error === 'string') {
    return (
      normalizeOptionalText(error, 'to_undefined', { fieldName: 'workflow_admission_error' }) ??
      'workflow_admission_error'
    ).slice(0, 256);
  }
  return 'workflow_admission_error';
}
