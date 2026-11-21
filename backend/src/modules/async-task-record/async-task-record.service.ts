// src/modules/async-task-record/async-task-record.service.ts
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { QueryFailedError, Repository } from 'typeorm';
import {
  CAPABILITY_STATE_READER,
  type CapabilityStateReader,
} from '@src/modules/common/capability-state-reader.contract';
import { AsyncTaskRecordEntity } from './async-task-record.entity';
import type {
  AsyncTaskRecordStatus,
  AsyncTaskRecordView,
  CreateAsyncTaskRecordInput,
  FindAsyncTaskRecordByQueueJobInput,
  RecordAsyncTaskEnqueuedInput,
  RecordAsyncTaskEnqueueFailedInput,
  RecordAsyncTaskFinishedInput,
  RecordAsyncTaskStartedInput,
  UpdateAsyncTaskRecordStatusInput,
} from './async-task-record.types';

/** 允许被条件取消的非终态 */
const CANCELLABLE_ASYNC_TASK_STATUSES: ReadonlyArray<AsyncTaskRecordStatus> = [
  'queued',
  'processing',
];

@Injectable()
export class AsyncTaskRecordService {
  constructor(
    @InjectRepository(AsyncTaskRecordEntity)
    private readonly asyncTaskRecordRepository: Repository<AsyncTaskRecordEntity>,
    @Inject(CAPABILITY_STATE_READER)
    private readonly capabilityStateReader: CapabilityStateReader,
  ) {}

  private async findByQueueJob(input: {
    readonly where: FindAsyncTaskRecordByQueueJobInput;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<AsyncTaskRecordView | null> {
    const repository = this.getRepository(input.transactionContext);
    const entity = await repository.findOne({ where: input.where });
    return entity ? this.toView(entity) : null;
  }

  async createRecord(input: {
    readonly data: CreateAsyncTaskRecordInput;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<AsyncTaskRecordView> {
    const repository = this.getRepository(input.transactionContext);
    const entity = repository.create({
      queueName: input.data.queueName,
      jobName: input.data.jobName,
      jobId: input.data.jobId,
      traceId: input.data.traceId,
      actorAccountId: input.data.actorAccountId ?? null,
      actorActiveRole: input.data.actorActiveRole ?? null,
      bizType: input.data.bizType,
      bizKey: input.data.bizKey,
      bizSubKey: input.data.bizSubKey ?? null,
      source: input.data.source,
      reason: input.data.reason ?? null,
      occurredAt: input.data.occurredAt ?? null,
      dedupKey: input.data.dedupKey ?? null,
      status: input.data.status,
      attemptCount: input.data.attemptCount ?? 0,
      maxAttempts: input.data.maxAttempts ?? null,
      enqueuedAt: input.data.enqueuedAt,
      startedAt: input.data.startedAt ?? null,
      finishedAt: input.data.finishedAt ?? null,
    });
    const saved = await repository.save(entity);
    return this.toView(saved);
  }

  async createRecordIfAbsent(input: {
    readonly data: CreateAsyncTaskRecordInput;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<AsyncTaskRecordView> {
    try {
      return await this.createRecord(input);
    } catch (error: unknown) {
      if (!this.isUniqueConstraintViolation(error)) {
        throw error;
      }
      const existing = await this.findByQueueJob({
        where: {
          queueName: input.data.queueName,
          jobId: input.data.jobId,
        },
        transactionContext: input.transactionContext,
      });
      if (existing) {
        return existing;
      }
      throw error;
    }
  }

  async recordEnqueued(input: {
    readonly data: RecordAsyncTaskEnqueuedInput;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<AsyncTaskRecordView> {
    const occurredAt = input.data.occurredAt ?? input.data.enqueuedAt ?? new Date();
    const enqueuedAt = input.data.enqueuedAt ?? occurredAt;
    return await this.createRecordIfAbsent({
      data: {
        queueName: input.data.queueName,
        jobName: input.data.jobName,
        jobId: input.data.jobId,
        traceId: input.data.traceId,
        actorAccountId: input.data.actorAccountId,
        actorActiveRole: input.data.actorActiveRole,
        bizType: input.data.bizType,
        bizKey: input.data.bizKey,
        bizSubKey: input.data.bizSubKey,
        source: input.data.source,
        reason: input.data.reason,
        occurredAt,
        dedupKey: input.data.dedupKey,
        status: 'queued',
        attemptCount: 0,
        maxAttempts: input.data.maxAttempts,
        enqueuedAt,
      },
      transactionContext: input.transactionContext,
    });
  }

  async recordEnqueueFailed(input: {
    readonly data: RecordAsyncTaskEnqueueFailedInput;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<AsyncTaskRecordView> {
    const occurredAt = input.data.occurredAt ?? new Date();
    const normalizedInputJobId = this.normalizeProvidedJobId(input.data.jobId);
    const resolvedJobId = this.resolveJobId({
      jobId: input.data.jobId,
      traceId: input.data.traceId,
      occurredAt,
    });
    const buildCreateData = (jobId: string): CreateAsyncTaskRecordInput => ({
      queueName: input.data.queueName,
      jobName: input.data.jobName,
      jobId,
      traceId: input.data.traceId,
      actorAccountId: input.data.actorAccountId,
      actorActiveRole: input.data.actorActiveRole,
      bizType: input.data.bizType,
      bizKey: input.data.bizKey,
      bizSubKey: input.data.bizSubKey,
      source: input.data.source,
      reason: input.data.reason ?? 'enqueue_failed',
      occurredAt,
      dedupKey: input.data.dedupKey,
      status: 'failed',
      attemptCount: 0,
      maxAttempts: input.data.maxAttempts,
      enqueuedAt: occurredAt,
      finishedAt: occurredAt,
    });
    try {
      return await this.createRecord({
        data: buildCreateData(resolvedJobId),
        transactionContext: input.transactionContext,
      });
    } catch (error: unknown) {
      if (!this.isUniqueConstraintViolation(error)) {
        throw error;
      }
      if (!normalizedInputJobId || resolvedJobId !== normalizedInputJobId) {
        throw error;
      }
      const fallbackJobId = this.resolveJobId({
        jobId: undefined,
        traceId: input.data.traceId,
        occurredAt,
      });
      return await this.createRecord({
        data: buildCreateData(fallbackJobId),
        transactionContext: input.transactionContext,
      });
    }
  }

  async recordStarted(input: {
    readonly data: RecordAsyncTaskStartedInput;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<AsyncTaskRecordView> {
    const startedAt = input.data.startedAt ?? new Date();
    const occurredAt = input.data.occurredAt ?? startedAt;
    const existing = await this.findByQueueJob({
      where: { queueName: input.data.queueName, jobId: input.data.jobId },
      transactionContext: input.transactionContext,
    });
    const attemptCount = input.data.attemptCount ?? Math.max((existing?.attemptCount ?? 0) + 1, 1);

    if (existing) {
      const updated = await this.updateStatusByQueueJob({
        where: { queueName: input.data.queueName, jobId: input.data.jobId },
        patch: {
          status: 'processing',
          ...(input.data.overwriteExistingSource ? { source: input.data.source } : {}),
          startedAt,
          occurredAt,
          attemptCount,
          ...(input.data.overwriteExistingMaxAttempts
            ? { maxAttempts: input.data.maxAttempts }
            : {}),
          reason: input.data.reason,
        },
        transactionContext: input.transactionContext,
      });
      if (updated) {
        return updated;
      }
    }

    return await this.createRecord({
      data: {
        queueName: input.data.queueName,
        jobName: input.data.jobName,
        jobId: input.data.jobId,
        traceId: input.data.traceId,
        actorAccountId: input.data.actorAccountId,
        actorActiveRole: input.data.actorActiveRole,
        bizType: input.data.bizType,
        bizKey: input.data.bizKey,
        bizSubKey: input.data.bizSubKey,
        source: input.data.source,
        reason: input.data.reason,
        occurredAt,
        dedupKey: input.data.dedupKey,
        status: 'processing',
        attemptCount,
        maxAttempts: input.data.maxAttempts,
        enqueuedAt: input.data.enqueuedAt ?? startedAt,
        startedAt,
      },
      transactionContext: input.transactionContext,
    });
  }

  async recordStartedIfAbsent(input: {
    readonly data: RecordAsyncTaskStartedInput;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<{
    readonly record: AsyncTaskRecordView;
    readonly created: boolean;
  }> {
    const existing = await this.findByQueueJob({
      where: {
        queueName: input.data.queueName,
        jobId: input.data.jobId,
      },
      transactionContext: input.transactionContext,
    });
    if (existing) {
      return {
        record: existing,
        created: false,
      };
    }

    const startedAt = input.data.startedAt ?? new Date();
    const occurredAt = input.data.occurredAt ?? startedAt;

    try {
      const record = await this.createRecord({
        data: {
          queueName: input.data.queueName,
          jobName: input.data.jobName,
          jobId: input.data.jobId,
          traceId: input.data.traceId,
          actorAccountId: input.data.actorAccountId,
          actorActiveRole: input.data.actorActiveRole,
          bizType: input.data.bizType,
          bizKey: input.data.bizKey,
          bizSubKey: input.data.bizSubKey,
          source: input.data.source,
          reason: input.data.reason,
          occurredAt,
          dedupKey: input.data.dedupKey,
          status: 'processing',
          attemptCount: input.data.attemptCount ?? 1,
          maxAttempts: input.data.maxAttempts,
          enqueuedAt: input.data.enqueuedAt ?? startedAt,
          startedAt,
        },
        transactionContext: input.transactionContext,
      });
      return {
        record,
        created: true,
      };
    } catch (error: unknown) {
      if (!this.isUniqueConstraintViolation(error)) {
        throw error;
      }
      const duplicated = await this.findByQueueJob({
        where: {
          queueName: input.data.queueName,
          jobId: input.data.jobId,
        },
        transactionContext: input.transactionContext,
      });
      if (!duplicated) {
        throw error;
      }
      return {
        record: duplicated,
        created: false,
      };
    }
  }

  async recordFinished(input: {
    readonly data: RecordAsyncTaskFinishedInput;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<AsyncTaskRecordView> {
    const finishedAt = input.data.finishedAt ?? new Date();
    const occurredAt = input.data.occurredAt ?? finishedAt;
    const existing = await this.findByQueueJob({
      where: { queueName: input.data.queueName, jobId: input.data.jobId },
      transactionContext: input.transactionContext,
    });
    const attemptCount = input.data.attemptCount ?? existing?.attemptCount ?? 1;

    if (existing) {
      const updated = await this.updateStatusByQueueJob({
        where: { queueName: input.data.queueName, jobId: input.data.jobId },
        patch: {
          status: input.data.status,
          ...(input.data.overwriteExistingSource ? { source: input.data.source } : {}),
          finishedAt,
          occurredAt,
          attemptCount,
          ...(input.data.overwriteExistingMaxAttempts
            ? { maxAttempts: input.data.maxAttempts }
            : {}),
          reason: input.data.reason,
        },
        transactionContext: input.transactionContext,
      });
      if (updated) {
        return updated;
      }
    }

    return await this.createRecord({
      data: {
        queueName: input.data.queueName,
        jobName: input.data.jobName,
        jobId: input.data.jobId,
        traceId: input.data.traceId,
        actorAccountId: input.data.actorAccountId,
        actorActiveRole: input.data.actorActiveRole,
        bizType: input.data.bizType,
        bizKey: input.data.bizKey,
        bizSubKey: input.data.bizSubKey,
        source: input.data.source,
        reason: input.data.reason,
        occurredAt,
        dedupKey: input.data.dedupKey,
        status: input.data.status,
        attemptCount,
        maxAttempts: input.data.maxAttempts,
        enqueuedAt: input.data.enqueuedAt ?? finishedAt,
        startedAt: input.data.startedAt ?? null,
        finishedAt,
      },
      transactionContext: input.transactionContext,
    });
  }

  /**
   * 条件取消：仅把仍处于 queued/processing 的账本行置为 cancelled。
   *
   * 与 updateStatusByQueueJob 的覆盖式 patch 不同，本方法带状态前置条件，
   * 不会把已终态（succeeded/failed/cancelled）行改写为 cancelled；
   * 用于业务删除（如客户删除报修）时在同一事务内撤销尚未执行的投递意图。
   */
  async cancelActiveByQueueJobIds(input: {
    readonly queueName: string;
    readonly jobIds: ReadonlyArray<string>;
    readonly reason: string;
    readonly finishedAt?: Date;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<number> {
    if (input.jobIds.length === 0) {
      return 0;
    }
    const repository = this.getRepository(input.transactionContext);
    const result = await repository
      .createQueryBuilder()
      .update(AsyncTaskRecordEntity)
      .set({
        status: 'cancelled',
        reason: input.reason,
        finishedAt: input.finishedAt ?? new Date(),
      })
      .where('queue_name = :queueName', { queueName: input.queueName })
      .andWhere('job_id IN (:...jobIds)', { jobIds: [...input.jobIds] })
      .andWhere('status IN (:...statuses)', { statuses: [...CANCELLABLE_ASYNC_TASK_STATUSES] })
      .execute();
    return result.affected ?? 0;
  }

  /**
   * 带状态前置条件的账本收敛（崩溃恢复 / 受控终结用）。
   *
   * 与 updateStatusByQueueJob 的覆盖式写入不同：
   * - 只更新调用方「实际观察到的那一行状态」（fromStatuses 由扫描结果传入），
   *   并发收尾时后到者命中 0 行，不会把已落地的终态改写成另一种终态；
   * - 永不重写 succeeded 行（成功结果只能由真实执行产生，不能被补投/收敛改写）；
   * - 单条 UPDATE 自带原子性，不额外开事务，也不触碰 intake / attempt 业务状态。
   *
   * 返回受影响行数：0 表示已被并发收尾或状态已变化，调用方按跳过处理。
   */
  async settleByQueueJob(input: {
    readonly queueName: string;
    readonly jobId: string;
    readonly fromStatuses: ReadonlyArray<AsyncTaskRecordStatus>;
    readonly status: AsyncTaskRecordStatus;
    readonly reason?: string | null;
    readonly finishedAt?: Date;
    readonly occurredAt?: Date;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<number> {
    if (input.fromStatuses.length === 0) {
      return 0;
    }
    if (input.fromStatuses.includes('succeeded')) {
      // 编程错误：成功账本行不得作为收敛来源
      throw new Error('async_task_settle_from_succeeded_rejected');
    }
    const occurredAt = input.occurredAt ?? input.finishedAt ?? new Date();
    const patch: UpdateAsyncTaskRecordStatusInput = {
      status: input.status,
      occurredAt,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
    };
    const repository = this.getRepository(input.transactionContext);
    const result = await repository
      .createQueryBuilder()
      .update(AsyncTaskRecordEntity)
      .set(patch)
      .where('queue_name = :queueName', { queueName: input.queueName })
      .andWhere('job_id = :jobId', { jobId: input.jobId })
      .andWhere('status IN (:...fromStatuses)', { fromStatuses: [...input.fromStatuses] })
      .execute();
    return result.affected ?? 0;
  }

  async updateStatusByQueueJob(input: {
    readonly where: FindAsyncTaskRecordByQueueJobInput;
    readonly patch: UpdateAsyncTaskRecordStatusInput;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<AsyncTaskRecordView | null> {
    const repository = this.getRepository(input.transactionContext);
    const entity = await repository.findOne({ where: input.where });
    if (!entity) {
      return null;
    }
    if (input.patch.status !== undefined) {
      entity.status = input.patch.status;
    }
    if (input.patch.source !== undefined) {
      entity.source = input.patch.source;
    }
    if (input.patch.attemptCount !== undefined) {
      entity.attemptCount = input.patch.attemptCount;
    }
    if (input.patch.maxAttempts !== undefined) {
      entity.maxAttempts = input.patch.maxAttempts;
    }
    if (input.patch.startedAt !== undefined) {
      entity.startedAt = input.patch.startedAt;
    }
    if (input.patch.finishedAt !== undefined) {
      entity.finishedAt = input.patch.finishedAt;
    }
    if (input.patch.reason !== undefined) {
      entity.reason = input.patch.reason;
    }
    if (input.patch.occurredAt !== undefined) {
      entity.occurredAt = input.patch.occurredAt;
    }
    const saved = await repository.save(entity);
    return this.toView(saved);
  }

  private getRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<AsyncTaskRecordEntity> {
    this.capabilityStateReader.requireEnabled('runtime.async-task');
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(AsyncTaskRecordEntity) : this.asyncTaskRecordRepository;
  }

  private resolveJobId(input: {
    readonly jobId?: string;
    readonly traceId: string;
    readonly occurredAt: Date;
  }): string {
    const normalized = this.normalizeProvidedJobId(input.jobId);
    if (normalized) {
      return normalized;
    }
    return `enqueue-failed:${input.traceId}:${input.occurredAt.getTime()}`;
  }

  private normalizeProvidedJobId(jobId?: string): string | undefined {
    if (typeof jobId !== 'string') {
      return undefined;
    }
    const normalized = jobId.trim();
    if (normalized.length === 0) {
      return undefined;
    }
    return normalized;
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

  private toView(entity: AsyncTaskRecordEntity): AsyncTaskRecordView {
    return {
      id: entity.id,
      queueName: entity.queueName,
      jobName: entity.jobName,
      jobId: entity.jobId,
      traceId: entity.traceId,
      actorAccountId: entity.actorAccountId,
      actorActiveRole: entity.actorActiveRole,
      bizType: entity.bizType,
      bizKey: entity.bizKey,
      bizSubKey: entity.bizSubKey,
      source: entity.source,
      reason: entity.reason,
      occurredAt: entity.occurredAt,
      dedupKey: entity.dedupKey,
      status: entity.status,
      attemptCount: entity.attemptCount,
      maxAttempts: entity.maxAttempts,
      enqueuedAt: entity.enqueuedAt,
      startedAt: entity.startedAt,
      finishedAt: entity.finishedAt,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}
