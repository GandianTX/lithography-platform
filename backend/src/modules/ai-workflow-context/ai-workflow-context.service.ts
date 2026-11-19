// src/modules/ai-workflow-context/ai-workflow-context.service.ts
import { createHash, randomUUID } from 'node:crypto';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { AI_WORKFLOW_CONTEXT_ERROR, DomainError } from '@core/common/errors/domain-error';
import {
  normalizeOptionalText,
  normalizeRequiredText,
} from '@core/common/input-normalize/input-normalize.policy';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import {
  CAPABILITY_STATE_READER,
  type CapabilityStateReader,
} from '@src/modules/common/capability-state-reader.contract';
import {
  In,
  IsNull,
  LessThanOrEqual,
  MoreThan,
  QueryFailedError,
  Repository,
  type FindOptionsWhere,
  type QueryDeepPartialEntity,
} from 'typeorm';
import { AiWorkflowContextEntity } from './ai-workflow-context.entity';
import {
  AI_WORKFLOW_CONTEXT_ACTIVE_STATUSES,
  AI_WORKFLOW_CONTEXT_TERMINAL_STATUSES,
  AI_WORKFLOW_CONTEXT_PAYLOAD_MAX_BYTES,
  type AiWorkflowContextHousekeepingCandidate,
  type AiWorkflowContextMutationResult,
  type AiWorkflowContextStatus,
  type AiWorkflowContextView,
  type AiWorkflowJsonPayload,
  type AiWorkflowJsonValue,
  type AiWorkflowPayloadReadResult,
  type CreateAiWorkflowContextInput,
  type CreateAiWorkflowContextResult,
  type LinkAiWorkflowAsyncTaskRecordInput,
  type LinkAiWorkflowTerminalAsyncTaskRecordInput,
  type ListAiWorkflowDueAdmissionWaitingInput,
  type ListAiWorkflowStaleQueuedInput,
  type ListAiWorkflowTerminalContextsInput,
  type MarkAiWorkflowAdmissionWaitingInput,
  type MarkAiWorkflowCancelledInput,
  type MarkAiWorkflowFailedForWorkerInput,
  type MarkAiWorkflowFailedInput,
  type MarkAiWorkflowProcessingForWorkerInput,
  type MarkAiWorkflowQueuedForAdmissionInput,
  type MarkAiWorkflowSucceededForWorkerInput,
  type MarkAiWorkflowSucceededInput,
  type ReleaseAiWorkflowProcessingForRetryInput,
  type WriteAiWorkflowOutputPayloadForWorkerInput,
  type WriteAiWorkflowOutputPayloadInput,
} from './ai-workflow-context.types';
import {
  requireAiWorkflowEnabled,
  requireAiWorkflowTerminalDrain,
} from './ai-workflow-capability.gate';

const HOUSEKEEPING_SELECT_COLUMNS = [
  'context.workflowId',
  'context.workflowType',
  'context.traceId',
  'context.queueName',
  'context.jobName',
  'context.jobId',
  'context.asyncTaskRecordId',
  'context.bizType',
  'context.bizKey',
  'context.bizSubKey',
  'context.source',
  'context.actorAccountId',
  'context.actorActiveRole',
  'context.provider',
  'context.model',
  'context.status',
  'context.nextEnqueueAt',
  'context.admissionExpiresAt',
  'context.createdAt',
  'context.updatedAt',
] as const;

@Injectable()
export class AiWorkflowContextService {
  constructor(
    @InjectRepository(AiWorkflowContextEntity)
    private readonly aiWorkflowContextRepository: Repository<AiWorkflowContextEntity>,
    @Inject(CAPABILITY_STATE_READER)
    private readonly capabilityStateReader: CapabilityStateReader,
  ) {}

  async createContext(input: CreateAiWorkflowContextInput): Promise<CreateAiWorkflowContextResult> {
    const workflowType = normalizeRequiredString(input.workflowType, 'workflowType');
    const dedupHash = this.hashOptionalDedupKey(input.workflowDedupKey);
    const repository = this.resolveRepository(input.transactionContext);

    if (dedupHash) {
      const existing = await this.findActiveEntityByDedupHash({
        repository,
        workflowType,
        dedupHash,
      });
      if (existing) {
        return { status: 'EXISTING_ACTIVE', context: this.toView(existing) };
      }
    }

    const inputPayloadJson = normalizePayload(input.inputPayload);
    const entity = repository.create({
      workflowId: randomUUID(),
      workflowType,
      workflowDedupHash: cloneBuffer(dedupHash),
      workflowDedupActiveHash: cloneBuffer(dedupHash),
      traceId: normalizeNullableString(input.traceId, 'traceId') ?? randomUUID(),
      queueName: null,
      jobName: null,
      jobId: null,
      asyncTaskRecordId: null,
      bizType: normalizeRequiredString(input.bizType, 'bizType'),
      bizKey: normalizeRequiredString(input.bizKey, 'bizKey'),
      bizSubKey: normalizeNullableString(input.bizSubKey, 'bizSubKey'),
      source: input.source,
      actorAccountId: input.actorAccountId ?? null,
      actorActiveRole: normalizeNullableString(input.actorActiveRole, 'actorActiveRole'),
      provider: normalizeNullableString(input.provider, 'provider'),
      model: normalizeNullableString(input.model, 'model'),
      status: 'CREATED',
      inputPayloadJson,
      outputPayloadJson: null,
      admissionAttemptCount: 0,
      nextEnqueueAt: null,
      admissionExpiresAt: null,
      admissionReason: null,
      errorCode: null,
      errorMessage: null,
    });

    try {
      const saved = await repository.save(entity);
      return { status: 'CREATED', context: this.toView(saved) };
    } catch (error: unknown) {
      if (dedupHash && this.isUniqueConstraintViolation(error)) {
        const existing = await this.findActiveEntityByDedupHash({
          repository,
          workflowType,
          dedupHash,
        });
        if (existing) {
          return { status: 'EXISTING_ACTIVE', context: this.toView(existing) };
        }
      }
      throw new DomainError(
        AI_WORKFLOW_CONTEXT_ERROR.CREATE_FAILED,
        '创建 AI workflow context 失败',
        { workflowType },
        error,
      );
    }
  }

  async findByWorkflowId(input: {
    readonly workflowId: string;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<AiWorkflowContextView | null> {
    const entity = await this.findEntityByWorkflowId(input);
    return entity ? this.toView(entity) : null;
  }

  /**
   * 按业务目标读取「最近创建」的工作流执行 ID（任务05 F04 的当前执行判定输入）。
   *
   * 同一业务子键（如问题 UUID）在重试后会新建一条上下文；最近创建者即当前执行，
   * 旧执行迟到时与本值不一致，可据此拒绝写回。只读最小字段，不返回负载内容。
   */
  async findLatestWorkflowIdByBizTarget(input: {
    readonly bizType: string;
    readonly bizSubKey: string;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<string | null> {
    const repository = this.resolveRepository(input.transactionContext);
    const entity = await repository.findOne({
      where: {
        bizType: normalizeRequiredString(input.bizType, 'bizType'),
        bizSubKey: normalizeRequiredString(input.bizSubKey, 'bizSubKey'),
      },
      select: { workflowId: true },
      order: { createdAt: 'DESC', workflowId: 'DESC' },
    });
    return entity?.workflowId ?? null;
  }

  async findActiveByDedupKey(input: {
    readonly workflowType: string;
    readonly workflowDedupKey: string;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<AiWorkflowContextView | null> {
    const repository = this.resolveRepository(input.transactionContext);
    const entity = await this.findActiveEntityByDedupHash({
      repository,
      workflowType: normalizeRequiredString(input.workflowType, 'workflowType'),
      dedupHash: hashWorkflowDedupKey(input.workflowDedupKey),
    });
    return entity ? this.toView(entity) : null;
  }

  async listDueAdmissionWaitingContexts(
    input: ListAiWorkflowDueAdmissionWaitingInput,
  ): Promise<AiWorkflowContextHousekeepingCandidate[]> {
    const repository = this.resolveRepository(input.transactionContext);
    try {
      const entities = await repository
        .createQueryBuilder('context')
        .select([...HOUSEKEEPING_SELECT_COLUMNS])
        .where('context.status = :status', { status: 'ADMISSION_WAITING' })
        .andWhere('context.nextEnqueueAt IS NOT NULL')
        .andWhere('context.nextEnqueueAt <= :now', { now: input.now })
        .orderBy('context.nextEnqueueAt', 'ASC')
        .addOrderBy('context.createdAt', 'ASC')
        .take(normalizeListLimit(input.limit))
        .getMany();
      return entities.map((entity) => this.toHousekeepingCandidate(entity));
    } catch (error: unknown) {
      throw new DomainError(
        AI_WORKFLOW_CONTEXT_ERROR.READ_FAILED,
        '读取 due admission waiting AI workflow context 失败',
        {},
        error,
      );
    }
  }

  async listStaleQueuedContexts(
    input: ListAiWorkflowStaleQueuedInput,
  ): Promise<AiWorkflowContextHousekeepingCandidate[]> {
    const repository = this.resolveRepository(input.transactionContext);
    try {
      const entities = await repository
        .createQueryBuilder('context')
        .select([...HOUSEKEEPING_SELECT_COLUMNS])
        .where('context.status = :status', { status: 'QUEUED' })
        .andWhere('context.jobId IS NOT NULL')
        .andWhere('context.updatedAt <= :staleBefore', { staleBefore: input.staleBefore })
        .orderBy('context.updatedAt', 'ASC')
        .addOrderBy('context.createdAt', 'ASC')
        .take(normalizeListLimit(input.limit))
        .getMany();
      return entities.map((entity) => this.toHousekeepingCandidate(entity));
    } catch (error: unknown) {
      throw new DomainError(
        AI_WORKFLOW_CONTEXT_ERROR.READ_FAILED,
        '读取 stale queued AI workflow context 失败',
        {},
        error,
      );
    }
  }

  async listTerminalContextsForDrain(
    input: ListAiWorkflowTerminalContextsInput,
  ): Promise<AiWorkflowContextHousekeepingCandidate[]> {
    const repository = this.resolveTerminalDrainRepository(input.transactionContext);
    try {
      const entities = await repository
        .createQueryBuilder('context')
        .select([...HOUSEKEEPING_SELECT_COLUMNS])
        .where('context.status IN (:...statuses)', {
          statuses: [...AI_WORKFLOW_CONTEXT_TERMINAL_STATUSES],
        })
        .andWhere('context.queueName IS NOT NULL')
        .andWhere('context.jobName IS NOT NULL')
        .andWhere('context.jobId IS NOT NULL')
        .orderBy('context.updatedAt', 'ASC')
        .addOrderBy('context.createdAt', 'ASC')
        .take(normalizeListLimit(input.limit))
        .getMany();
      return entities.map((entity) => this.toHousekeepingCandidate(entity));
    } catch (error: unknown) {
      throw new DomainError(
        AI_WORKFLOW_CONTEXT_ERROR.READ_FAILED,
        '读取 terminal AI workflow context 失败',
        {},
        error,
      );
    }
  }

  async readInputPayload(input: {
    readonly workflowId: string;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<AiWorkflowPayloadReadResult> {
    const entity = await this.requireEntityByWorkflowId(input);
    return {
      kind: 'PRESENT',
      payload: cloneJsonPayload(entity.inputPayloadJson),
    };
  }

  async readOutputPayload(input: {
    readonly workflowId: string;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<AiWorkflowPayloadReadResult> {
    const entity = await this.requireEntityByWorkflowId(input);
    if (entity.outputPayloadJson === null) {
      return { kind: 'NONE' };
    }
    return {
      kind: 'PRESENT',
      payload: cloneJsonPayload(entity.outputPayloadJson),
    };
  }

  async writeOutputPayload(
    input: WriteAiWorkflowOutputPayloadInput,
  ): Promise<AiWorkflowContextMutationResult> {
    return await this.updateByExpectedStatuses({
      workflowId: input.workflowId,
      expectedStatuses: input.expectedStatuses,
      patch: {
        outputPayloadJson: normalizePayload(input.outputPayload),
      },
      transactionContext: input.transactionContext,
    });
  }

  async writeOutputPayloadForWorker(
    input: WriteAiWorkflowOutputPayloadForWorkerInput,
  ): Promise<AiWorkflowContextMutationResult> {
    return await this.updateByExpectedStatusesAndJobId({
      workflowId: input.workflowId,
      jobId: input.jobId,
      expectedStatuses: input.expectedStatuses,
      patch: {
        outputPayloadJson: normalizePayload(input.outputPayload),
      },
      transactionContext: input.transactionContext,
    });
  }

  async markAdmissionWaiting(
    input: MarkAiWorkflowAdmissionWaitingInput,
  ): Promise<AiWorkflowContextMutationResult> {
    return await this.updateByExpectedStatuses({
      workflowId: input.workflowId,
      expectedStatuses: input.expectedStatuses,
      patch: {
        status: 'ADMISSION_WAITING',
        nextEnqueueAt: cloneDate(input.nextEnqueueAt),
        admissionExpiresAt: cloneDate(input.admissionExpiresAt),
        admissionReason: normalizeRequiredString(input.admissionReason, 'admissionReason'),
        admissionAttemptCount: () => 'admission_attempt_count + 1',
      },
      transactionContext: input.transactionContext,
    });
  }

  async markQueuedForAdmission(
    input: MarkAiWorkflowQueuedForAdmissionInput,
  ): Promise<AiWorkflowContextMutationResult> {
    const workflowId = normalizeRequiredString(input.workflowId, 'workflowId');
    const repository = this.resolveRepository(input.transactionContext);
    const now = cloneDate(input.now);
    const where: FindOptionsWhere<AiWorkflowContextEntity>[] = [
      {
        workflowId,
        status: 'CREATED',
        admissionExpiresAt: IsNull(),
      },
      {
        workflowId,
        status: 'CREATED',
        admissionExpiresAt: MoreThan(now),
      },
      {
        workflowId,
        status: 'ADMISSION_WAITING',
        nextEnqueueAt: LessThanOrEqual(now),
        admissionExpiresAt: IsNull(),
      },
      {
        workflowId,
        status: 'ADMISSION_WAITING',
        nextEnqueueAt: LessThanOrEqual(now),
        admissionExpiresAt: MoreThan(now),
      },
    ];
    const patch: QueryDeepPartialEntity<AiWorkflowContextEntity> = {
      status: 'QUEUED',
      queueName: normalizeRequiredString(input.queueName, 'queueName'),
      jobName: normalizeRequiredString(input.jobName, 'jobName'),
      jobId: normalizeRequiredString(input.jobId, 'jobId'),
      asyncTaskRecordId: null,
      nextEnqueueAt: null,
      admissionExpiresAt: cloneDate(input.admissionExpiresAt),
      admissionReason: null,
      errorCode: null,
      errorMessage: null,
    };

    try {
      const result = await repository.update(where, patch);
      if (result.affected === 1) {
        const updated = await this.requireEntityByWorkflowId({
          workflowId,
          transactionContext: input.transactionContext,
        });
        return { status: 'UPDATED', context: this.toView(updated) };
      }
    } catch (error: unknown) {
      throw new DomainError(
        AI_WORKFLOW_CONTEXT_ERROR.UPDATE_FAILED,
        '更新 AI workflow context admission 状态失败',
        { workflowId },
        error,
      );
    }
    return {
      status: 'CONFLICT',
      context: await this.findByWorkflowId({
        workflowId,
        transactionContext: input.transactionContext,
      }),
    };
  }

  async linkAsyncTaskRecord(
    input: LinkAiWorkflowAsyncTaskRecordInput,
  ): Promise<AiWorkflowContextMutationResult> {
    return await this.linkAsyncTaskRecordWithRepository({
      workflowId: input.workflowId,
      jobId: input.jobId,
      expectedStatuses: input.expectedStatuses,
      asyncTaskRecordId: input.asyncTaskRecordId,
      repository: this.resolveRepository(input.transactionContext),
    });
  }

  async linkTerminalAsyncTaskRecordForDrain(
    input: LinkAiWorkflowTerminalAsyncTaskRecordInput,
  ): Promise<AiWorkflowContextMutationResult> {
    if (
      input.expectedStatuses.length === 0 ||
      input.expectedStatuses.some(
        (status) => !AI_WORKFLOW_CONTEXT_TERMINAL_STATUSES.includes(status),
      )
    ) {
      throw new DomainError(
        AI_WORKFLOW_CONTEXT_ERROR.INVALID_PARAMS,
        'Terminal drain 只允许 terminal workflow status',
      );
    }
    return await this.linkAsyncTaskRecordWithRepository({
      workflowId: input.workflowId,
      jobId: input.jobId,
      expectedStatuses: input.expectedStatuses,
      asyncTaskRecordId: input.asyncTaskRecordId,
      repository: this.resolveTerminalDrainRepository(input.transactionContext),
    });
  }

  async markProcessingForWorker(
    input: MarkAiWorkflowProcessingForWorkerInput,
  ): Promise<AiWorkflowContextMutationResult> {
    const workflowId = normalizeRequiredString(input.workflowId, 'workflowId');
    const jobId = normalizeRequiredString(input.jobId, 'jobId');
    const repository = this.resolveRepository(input.transactionContext);
    const recoverBefore = new Date(input.now.getTime() - input.processingTimeoutMs);
    const where: FindOptionsWhere<AiWorkflowContextEntity>[] = [
      { workflowId, jobId, status: 'QUEUED' },
      { workflowId, jobId, status: 'PROCESSING', updatedAt: LessThanOrEqual(recoverBefore) },
    ];

    try {
      const result = await repository.update(where, {
        status: 'PROCESSING',
        errorCode: null,
        errorMessage: null,
      });
      if (result.affected === 1) {
        const updated = await this.requireEntityByWorkflowId({
          workflowId,
          transactionContext: input.transactionContext,
        });
        return { status: 'UPDATED', context: this.toView(updated) };
      }
    } catch (error: unknown) {
      throw new DomainError(
        AI_WORKFLOW_CONTEXT_ERROR.UPDATE_FAILED,
        '更新 AI workflow context worker processing 状态失败',
        { workflowId },
        error,
      );
    }
    return {
      status: 'CONFLICT',
      context: await this.findByWorkflowId({
        workflowId,
        transactionContext: input.transactionContext,
      }),
    };
  }

  async releaseProcessingForRetry(
    input: ReleaseAiWorkflowProcessingForRetryInput,
  ): Promise<AiWorkflowContextMutationResult> {
    return await this.updateByExpectedStatusesAndJobId({
      workflowId: input.workflowId,
      jobId: input.jobId,
      expectedStatuses: ['PROCESSING'],
      patch: {
        status: 'QUEUED',
      },
      transactionContext: input.transactionContext,
    });
  }

  async markSucceededForWorker(
    input: MarkAiWorkflowSucceededForWorkerInput,
  ): Promise<AiWorkflowContextMutationResult> {
    return await this.updateByExpectedStatusesAndJobId({
      workflowId: input.workflowId,
      jobId: input.jobId,
      expectedStatuses: ['PROCESSING'],
      patch: this.createTerminalPatch({
        status: 'SUCCEEDED',
        errorCode: null,
        errorMessage: null,
      }),
      transactionContext: input.transactionContext,
    });
  }

  async markFailedForWorker(
    input: MarkAiWorkflowFailedForWorkerInput,
  ): Promise<AiWorkflowContextMutationResult> {
    return await this.updateByExpectedStatusesAndJobId({
      workflowId: input.workflowId,
      jobId: input.jobId,
      expectedStatuses: ['PROCESSING'],
      patch: this.createTerminalPatch({
        status: 'FAILED',
        errorCode: normalizeRequiredString(input.errorCode, 'errorCode'),
        errorMessage: normalizeRequiredString(input.errorMessage, 'errorMessage'),
      }),
      transactionContext: input.transactionContext,
    });
  }

  async markSucceeded(
    input: MarkAiWorkflowSucceededInput,
  ): Promise<AiWorkflowContextMutationResult> {
    return await this.updateByExpectedStatuses({
      workflowId: input.workflowId,
      expectedStatuses: input.expectedStatuses,
      patch: this.createTerminalPatch({
        status: 'SUCCEEDED',
        errorCode: null,
        errorMessage: null,
      }),
      transactionContext: input.transactionContext,
    });
  }

  async markFailed(input: MarkAiWorkflowFailedInput): Promise<AiWorkflowContextMutationResult> {
    return await this.updateByExpectedStatuses({
      workflowId: input.workflowId,
      expectedStatuses: input.expectedStatuses,
      patch: this.createTerminalPatch({
        status: 'FAILED',
        errorCode: normalizeRequiredString(input.errorCode, 'errorCode'),
        errorMessage: normalizeRequiredString(input.errorMessage, 'errorMessage'),
      }),
      transactionContext: input.transactionContext,
    });
  }

  async markCancelled(
    input: MarkAiWorkflowCancelledInput,
  ): Promise<AiWorkflowContextMutationResult> {
    return await this.updateByExpectedStatuses({
      workflowId: input.workflowId,
      expectedStatuses: input.expectedStatuses,
      patch: this.createTerminalPatch({
        status: 'CANCELLED',
        errorCode: normalizeNullableString(input.errorCode, 'errorCode'),
        errorMessage: normalizeNullableString(input.errorMessage, 'errorMessage'),
      }),
      transactionContext: input.transactionContext,
    });
  }

  private createTerminalPatch(input: {
    readonly status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
  }): QueryDeepPartialEntity<AiWorkflowContextEntity> {
    return {
      status: input.status,
      workflowDedupActiveHash: null,
      nextEnqueueAt: null,
      admissionReason: null,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    };
  }

  private async updateByExpectedStatuses(input: {
    readonly workflowId: string;
    readonly expectedStatuses: readonly AiWorkflowContextStatus[];
    readonly patch: QueryDeepPartialEntity<AiWorkflowContextEntity>;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<AiWorkflowContextMutationResult> {
    const workflowId = normalizeRequiredString(input.workflowId, 'workflowId');
    if (input.expectedStatuses.length === 0) {
      return {
        status: 'CONFLICT',
        context: await this.findByWorkflowId({
          workflowId,
          transactionContext: input.transactionContext,
        }),
      };
    }
    const repository = this.resolveRepository(input.transactionContext);

    try {
      const result = await repository.update(
        { workflowId, status: In([...input.expectedStatuses]) },
        input.patch,
      );
      if (result.affected === 1) {
        const updated = await this.requireEntityByWorkflowId({
          workflowId,
          transactionContext: input.transactionContext,
        });
        return { status: 'UPDATED', context: this.toView(updated) };
      }
    } catch (error: unknown) {
      throw new DomainError(
        AI_WORKFLOW_CONTEXT_ERROR.UPDATE_FAILED,
        '更新 AI workflow context 失败',
        { workflowId },
        error,
      );
    }
    return {
      status: 'CONFLICT',
      context: await this.findByWorkflowId({
        workflowId,
        transactionContext: input.transactionContext,
      }),
    };
  }

  private async updateByExpectedStatusesAndJobId(input: {
    readonly workflowId: string;
    readonly jobId: string;
    readonly expectedStatuses: readonly AiWorkflowContextStatus[];
    readonly patch: QueryDeepPartialEntity<AiWorkflowContextEntity>;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<AiWorkflowContextMutationResult> {
    const workflowId = normalizeRequiredString(input.workflowId, 'workflowId');
    const jobId = normalizeRequiredString(input.jobId, 'jobId');
    if (input.expectedStatuses.length === 0) {
      return {
        status: 'CONFLICT',
        context: await this.findByWorkflowId({
          workflowId,
          transactionContext: input.transactionContext,
        }),
      };
    }
    const repository = this.resolveRepository(input.transactionContext);

    try {
      const result = await repository.update(
        { workflowId, jobId, status: In([...input.expectedStatuses]) },
        input.patch,
      );
      if (result.affected === 1) {
        const updated = await this.requireEntityByWorkflowId({
          workflowId,
          transactionContext: input.transactionContext,
        });
        return { status: 'UPDATED', context: this.toView(updated) };
      }
    } catch (error: unknown) {
      throw new DomainError(
        AI_WORKFLOW_CONTEXT_ERROR.UPDATE_FAILED,
        '更新 AI workflow context 失败',
        { workflowId, jobId },
        error,
      );
    }
    return {
      status: 'CONFLICT',
      context: await this.findByWorkflowId({
        workflowId,
        transactionContext: input.transactionContext,
      }),
    };
  }

  private async linkAsyncTaskRecordWithRepository(input: {
    readonly workflowId: string;
    readonly jobId: string;
    readonly asyncTaskRecordId: number;
    readonly expectedStatuses: readonly AiWorkflowContextStatus[];
    readonly repository: Repository<AiWorkflowContextEntity>;
  }): Promise<AiWorkflowContextMutationResult> {
    const workflowId = normalizeRequiredString(input.workflowId, 'workflowId');
    const jobId = normalizeRequiredString(input.jobId, 'jobId');
    if (input.expectedStatuses.length === 0) {
      const current = await this.findEntityByWorkflowIdWithRepository({
        workflowId,
        repository: input.repository,
      });
      return { status: 'CONFLICT', context: current ? this.toView(current) : null };
    }

    try {
      const result = await input.repository.update(
        { workflowId, jobId, status: In([...input.expectedStatuses]) },
        { asyncTaskRecordId: input.asyncTaskRecordId },
      );
      if (result.affected === 1) {
        const updated = await this.findEntityByWorkflowIdWithRepository({
          workflowId,
          repository: input.repository,
        });
        if (!updated) {
          throw new DomainError(AI_WORKFLOW_CONTEXT_ERROR.NOT_FOUND, 'AI workflow context 不存在', {
            workflowId,
          });
        }
        return { status: 'UPDATED', context: this.toView(updated) };
      }
    } catch (error: unknown) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        AI_WORKFLOW_CONTEXT_ERROR.UPDATE_FAILED,
        '更新 AI workflow context async task 关联失败',
        { workflowId, jobId },
        error,
      );
    }

    const current = await this.findEntityByWorkflowIdWithRepository({
      workflowId,
      repository: input.repository,
    });
    return { status: 'CONFLICT', context: current ? this.toView(current) : null };
  }

  private async findEntityByWorkflowId(input: {
    readonly workflowId: string;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<AiWorkflowContextEntity | null> {
    const repository = this.resolveRepository(input.transactionContext);
    return await this.findEntityByWorkflowIdWithRepository({
      workflowId: input.workflowId,
      repository,
    });
  }

  private async findEntityByWorkflowIdWithRepository(input: {
    readonly workflowId: string;
    readonly repository: Repository<AiWorkflowContextEntity>;
  }): Promise<AiWorkflowContextEntity | null> {
    try {
      return await input.repository.findOne({
        where: { workflowId: normalizeRequiredString(input.workflowId, 'workflowId') },
      });
    } catch (error: unknown) {
      throw new DomainError(
        AI_WORKFLOW_CONTEXT_ERROR.READ_FAILED,
        '读取 AI workflow context 失败',
        { workflowId: input.workflowId },
        error,
      );
    }
  }

  private async requireEntityByWorkflowId(input: {
    readonly workflowId: string;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<AiWorkflowContextEntity> {
    const entity = await this.findEntityByWorkflowId(input);
    if (!entity) {
      throw new DomainError(AI_WORKFLOW_CONTEXT_ERROR.NOT_FOUND, 'AI workflow context 不存在', {
        workflowId: input.workflowId,
      });
    }
    return entity;
  }

  private async findActiveEntityByDedupHash(input: {
    readonly repository: Repository<AiWorkflowContextEntity>;
    readonly workflowType: string;
    readonly dedupHash: Buffer;
  }): Promise<AiWorkflowContextEntity | null> {
    try {
      return await input.repository.findOne({
        where: {
          workflowType: input.workflowType,
          workflowDedupActiveHash: input.dedupHash,
          status: In([...AI_WORKFLOW_CONTEXT_ACTIVE_STATUSES]),
        },
      });
    } catch (error: unknown) {
      throw new DomainError(
        AI_WORKFLOW_CONTEXT_ERROR.READ_FAILED,
        '读取 active AI workflow context 失败',
        { workflowType: input.workflowType },
        error,
      );
    }
  }

  private hashOptionalDedupKey(dedupKey?: string | null): Buffer | null {
    const normalized = normalizeNullableString(dedupKey, 'workflowDedupKey');
    return normalized ? hashWorkflowDedupKey(normalized) : null;
  }

  private resolveRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<AiWorkflowContextEntity> {
    requireAiWorkflowEnabled(this.capabilityStateReader);
    return this.resolveRepositoryWithoutGate(transactionContext);
  }

  private resolveTerminalDrainRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<AiWorkflowContextEntity> {
    requireAiWorkflowTerminalDrain(this.capabilityStateReader);
    return this.resolveRepositoryWithoutGate(transactionContext);
  }

  private resolveRepositoryWithoutGate(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<AiWorkflowContextEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager
      ? manager.getRepository(AiWorkflowContextEntity)
      : this.aiWorkflowContextRepository;
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }
    const errorObject = error as unknown as {
      readonly code?: string;
      readonly errno?: number;
      readonly sqlState?: string;
      readonly driverError?: {
        readonly code?: string;
        readonly errno?: number;
        readonly sqlState?: string;
      };
    };
    const driverCode = errorObject.driverError?.code;
    const driverErrno = errorObject.driverError?.errno;
    const driverSqlState = errorObject.driverError?.sqlState;
    if (
      driverCode === 'ER_DUP_ENTRY' ||
      driverErrno === 1062 ||
      driverSqlState === '23000' ||
      driverCode === '23505'
    ) {
      return true;
    }
    return (
      errorObject.code === 'ER_DUP_ENTRY' ||
      errorObject.errno === 1062 ||
      errorObject.sqlState === '23000' ||
      errorObject.code === '23505'
    );
  }

  private toView(entity: AiWorkflowContextEntity): AiWorkflowContextView {
    return {
      workflowId: entity.workflowId,
      workflowType: entity.workflowType,
      workflowDedupHash: cloneBuffer(entity.workflowDedupHash),
      workflowDedupActiveHash: cloneBuffer(entity.workflowDedupActiveHash),
      traceId: entity.traceId,
      queueName: entity.queueName,
      jobName: entity.jobName,
      jobId: entity.jobId,
      asyncTaskRecordId: entity.asyncTaskRecordId,
      bizType: entity.bizType,
      bizKey: entity.bizKey,
      bizSubKey: entity.bizSubKey,
      source: entity.source,
      actorAccountId: entity.actorAccountId,
      actorActiveRole: entity.actorActiveRole,
      provider: entity.provider,
      model: entity.model,
      status: entity.status,
      inputPayloadJson: cloneJsonPayload(entity.inputPayloadJson),
      outputPayloadJson:
        entity.outputPayloadJson === null ? null : cloneJsonPayload(entity.outputPayloadJson),
      admissionAttemptCount: entity.admissionAttemptCount,
      nextEnqueueAt: cloneOptionalDate(entity.nextEnqueueAt),
      admissionExpiresAt: cloneOptionalDate(entity.admissionExpiresAt),
      admissionReason: entity.admissionReason,
      errorCode: entity.errorCode,
      errorMessage: entity.errorMessage,
      createdAt: cloneDate(entity.createdAt),
      updatedAt: cloneDate(entity.updatedAt),
    };
  }

  private toHousekeepingCandidate(
    entity: AiWorkflowContextEntity,
  ): AiWorkflowContextHousekeepingCandidate {
    return {
      workflowId: entity.workflowId,
      workflowType: entity.workflowType,
      traceId: entity.traceId,
      queueName: entity.queueName,
      jobName: entity.jobName,
      jobId: entity.jobId,
      asyncTaskRecordId: entity.asyncTaskRecordId,
      bizType: entity.bizType,
      bizKey: entity.bizKey,
      bizSubKey: entity.bizSubKey,
      source: entity.source,
      actorAccountId: entity.actorAccountId,
      actorActiveRole: entity.actorActiveRole,
      provider: entity.provider,
      model: entity.model,
      status: entity.status,
      nextEnqueueAt: cloneOptionalDate(entity.nextEnqueueAt),
      admissionExpiresAt: cloneOptionalDate(entity.admissionExpiresAt),
      createdAt: cloneDate(entity.createdAt),
      updatedAt: cloneDate(entity.updatedAt),
    };
  }
}

function hashWorkflowDedupKey(dedupKey: string): Buffer {
  const normalized = normalizeRequiredString(dedupKey, 'workflowDedupKey');
  return createHash('sha256').update(normalized, 'utf8').digest();
}

function normalizePayload(payload: AiWorkflowJsonPayload): AiWorkflowJsonPayload {
  const normalized = normalizeJsonValue(payload, 'payload');
  if (normalized === null) {
    throw new DomainError(
      AI_WORKFLOW_CONTEXT_ERROR.PAYLOAD_INVALID,
      'AI workflow payload 根值不能为 null',
    );
  }
  const serialized = JSON.stringify(normalized);
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength > AI_WORKFLOW_CONTEXT_PAYLOAD_MAX_BYTES) {
    throw new DomainError(
      AI_WORKFLOW_CONTEXT_ERROR.PAYLOAD_TOO_LARGE,
      'AI workflow payload 超过 1 MiB',
      {
        byteLength,
        maxBytes: AI_WORKFLOW_CONTEXT_PAYLOAD_MAX_BYTES,
      },
    );
  }
  return normalized;
}

function cloneJsonPayload(payload: unknown): AiWorkflowJsonPayload {
  const normalized = normalizeJsonValue(payload, 'payload');
  if (normalized === null) {
    throw new DomainError(
      AI_WORKFLOW_CONTEXT_ERROR.PAYLOAD_INVALID,
      'AI workflow payload 根值不能为 null',
    );
  }
  return normalized;
}

function normalizeJsonValue(value: unknown, path: string): AiWorkflowJsonValue {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new DomainError(AI_WORKFLOW_CONTEXT_ERROR.PAYLOAD_INVALID, `${path} 包含非法数字`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeJsonValue(item, `${path}[${index}]`));
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DomainError(AI_WORKFLOW_CONTEXT_ERROR.PAYLOAD_INVALID, `${path} 必须是 JSON 对象`);
    }
    const record = value as Record<string, unknown>;
    const normalized: Record<string, AiWorkflowJsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) {
        throw new DomainError(
          AI_WORKFLOW_CONTEXT_ERROR.PAYLOAD_INVALID,
          `${path}.${key} 不能是 undefined`,
        );
      }
      normalized[key] = normalizeJsonValue(item, `${path}.${key}`);
    }
    return normalized;
  }
  throw new DomainError(AI_WORKFLOW_CONTEXT_ERROR.PAYLOAD_INVALID, `${path} 不是合法 JSON`);
}

function normalizeRequiredString(input: unknown, fieldName: string): string {
  return normalizeRequiredText(input, { fieldName });
}

function normalizeNullableString(input: unknown, fieldName: string): string | null {
  return normalizeOptionalText(input, 'to_null', { fieldName }) ?? null;
}

function normalizeListLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    throw new DomainError(AI_WORKFLOW_CONTEXT_ERROR.INVALID_PARAMS, 'limit 必须是有限数字');
  }
  const normalized = Math.trunc(limit);
  if (normalized < 1) {
    return 1;
  }
  if (normalized > 100) {
    return 100;
  }
  return normalized;
}

function cloneDate(date: Date): Date {
  return new Date(date.getTime());
}

function cloneOptionalDate(date: Date | null): Date | null {
  return date ? cloneDate(date) : null;
}

function cloneBuffer(buffer: Buffer | null): Buffer | null {
  return buffer ? Buffer.from(buffer) : null;
}
