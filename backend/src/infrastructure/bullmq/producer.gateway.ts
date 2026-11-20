// src/infrastructure/bullmq/producer.gateway.ts
import type { RecordSource } from '@app-types/common/record-source.types';
import { getQueueToken } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { type JobState, type JobsOptions, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { BULLMQ_QUEUE_JOBS, type BullMqQueueName } from './bullmq.constants';
import {
  assertBullMqJobPayload,
  type BullMqJobName,
  type BullMqJobPayload,
} from './contracts/job-contract.registry';
import { BULLMQ_QUEUE_REGISTRY } from './queue-registry';

export type BullMqEnqueueSource = RecordSource;

/** BullMQ 运行时状态的窄化视图：waiting 含 prioritized / waiting-children */
export type BullMqJobRuntimeState =
  'waiting' | 'active' | 'delayed' | 'completed' | 'failed' | 'unknown';

export interface BullMqEnqueueMeta {
  // 发起账号 ID、发起时承担的角色
  readonly actorAccountId?: number | string;
  readonly actorActiveRole?: string;
  // 目标对象
  readonly bizType: string;
  readonly bizKey: string;
  readonly bizSubKey?: string;
  // 触发来源、原因
  readonly source: BullMqEnqueueSource;
  readonly reason?: string;
  // 记录事件设定时间，即时任务应和当前时间一致，定时任务应和设置时间一致
  // ISO 8601 datetime string, e.g. "2023-01-01T00:00:00.000Z"
  readonly occurredAt?: string;
}

export interface EnqueueJobInput<Q extends BullMqQueueName, J extends BullMqJobName<Q>> {
  readonly queueName: Q;
  readonly jobName: J;
  readonly payload: BullMqJobPayload<Q, J>;
  readonly dedupKey?: string;
  readonly explicitJobId?: string;
  readonly traceId?: string;
  readonly auditMeta?: BullMqEnqueueMeta;
  readonly options?: Readonly<Partial<JobsOptions>>;
}

export interface EnqueueJobResult<Q extends BullMqQueueName, J extends BullMqJobName<Q>> {
  readonly queueName: Q;
  readonly jobName: J;
  readonly jobId: string;
  readonly traceId: string;
  readonly auditMeta?: BullMqEnqueueMeta;
}

@Injectable()
export class BullMqProducerGateway {
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BullMqProducerGateway.name);
  }

  async enqueue<Q extends BullMqQueueName, J extends BullMqJobName<Q>>(
    input: EnqueueJobInput<Q, J>,
  ): Promise<EnqueueJobResult<Q, J>> {
    this.assertQueueJobPair({ queueName: input.queueName, jobName: input.jobName });
    const traceId = input.traceId?.trim() || randomUUID();
    const payload = this.attachResolvedTraceIdToPayload({
      queueName: input.queueName,
      payload: input.payload,
      traceId,
    });
    assertBullMqJobPayload({
      queueName: input.queueName,
      jobName: input.jobName,
      payload,
    });
    const queue = this.getQueue({ queueName: input.queueName });
    const dedupKey = input.dedupKey?.trim() || undefined;
    const explicitJobId = this.normalizeExplicitJobId(input.explicitJobId);
    if (dedupKey && explicitJobId) {
      throw new Error(`explicit_job_id_conflicts_with_dedup_key:${input.queueName}`);
    }
    if (dedupKey) {
      const existingJob = await queue.getJob(dedupKey);
      if (existingJob) {
        if (existingJob.name !== input.jobName) {
          throw new Error(
            `dedup_job_name_conflict:${input.queueName}:${dedupKey}:${existingJob.name}->${input.jobName}`,
          );
        }
        const existingTraceId = this.readTraceIdFromPayload(existingJob.data);
        if (!existingTraceId) {
          throw new Error(
            `missing_existing_payload_trace_id:${input.queueName}/${input.jobName}:${dedupKey}`,
          );
        }
        const existingJobId =
          typeof existingJob.id === 'number'
            ? String(existingJob.id)
            : (existingJob.id ?? dedupKey);
        return {
          queueName: input.queueName,
          jobName: input.jobName,
          jobId: existingJobId,
          traceId: existingTraceId,
          auditMeta: input.auditMeta,
        };
      }
    }
    const jobId = dedupKey ?? explicitJobId ?? randomUUID();
    const policy = BULLMQ_QUEUE_REGISTRY[input.queueName];
    const options: JobsOptions = {
      ...policy.defaultJobOptions,
      ...input.options,
      jobId,
    };
    await queue.add(input.jobName, payload, options);
    this.logger.info(
      {
        queueName: input.queueName,
        jobName: input.jobName,
        jobId,
        traceId,
        auditMeta: input.auditMeta,
      },
      'BullMQ job enqueued',
    );
    return {
      queueName: input.queueName,
      jobName: input.jobName,
      jobId,
      traceId,
      auditMeta: input.auditMeta,
    };
  }

  async hasJob(input: { readonly queueName: BullMqQueueName; readonly jobId: string }): Promise<{
    readonly queueName: BullMqQueueName;
    readonly jobId: string;
    readonly exists: boolean;
  }> {
    const jobId = input.jobId.trim();
    if (!jobId) {
      throw new Error(`bullmq_job_id_required:${input.queueName}`);
    }
    const queue = this.getQueue({ queueName: input.queueName });
    const job = await queue.getJob(jobId);
    return {
      queueName: input.queueName,
      jobId,
      exists: job !== null && job !== undefined,
    };
  }

  /** 查询 job 的运行时状态：不存在（或不可辨识）返回 unknown */
  async getJobState(input: {
    readonly queueName: BullMqQueueName;
    readonly jobId: string;
  }): Promise<{
    readonly queueName: BullMqQueueName;
    readonly jobId: string;
    readonly state: BullMqJobRuntimeState;
  }> {
    const jobId = input.jobId.trim();
    if (!jobId) {
      throw new Error(`bullmq_job_id_required:${input.queueName}`);
    }
    const queue = this.getQueue({ queueName: input.queueName });
    const job = await queue.getJob(jobId);
    if (!job) {
      return { queueName: input.queueName, jobId, state: 'unknown' };
    }
    const rawState = await job.getState();
    return { queueName: input.queueName, jobId, state: normalizeBullMqJobState(rawState) };
  }

  /** 移除一个 job：返回 1 表示移除成功，0 表示不存在或被锁定（不抛错） */
  async removeJob(input: { readonly queueName: BullMqQueueName; readonly jobId: string }): Promise<{
    readonly queueName: BullMqQueueName;
    readonly jobId: string;
    readonly removed: boolean;
  }> {
    const jobId = input.jobId.trim();
    if (!jobId) {
      throw new Error(`bullmq_job_id_required:${input.queueName}`);
    }
    const queue = this.getQueue({ queueName: input.queueName });
    const code = await queue.remove(jobId);
    return { queueName: input.queueName, jobId, removed: code === 1 };
  }

  async checkQueueAvailable(input: { readonly queueName: BullMqQueueName }): Promise<{
    readonly queueName: BullMqQueueName;
    readonly available: true;
  }> {
    const queue = this.getQueue({ queueName: input.queueName });
    await queue.getJob('queue-health-probe');
    return {
      queueName: input.queueName,
      available: true,
    };
  }

  private getQueue(input: { readonly queueName: BullMqQueueName }): Queue {
    const token = getQueueToken(input.queueName);
    const queue = this.moduleRef.get<Queue>(token, { strict: false });
    if (!queue) {
      throw new Error(`BullMQ queue is not registered: ${input.queueName}`);
    }
    return queue;
  }

  private assertQueueJobPair<Q extends BullMqQueueName, J extends string>(input: {
    readonly queueName: Q;
    readonly jobName: J;
  }): void {
    const allowedJobs = BULLMQ_QUEUE_JOBS[input.queueName];
    if (!allowedJobs.includes(input.jobName)) {
      throw new Error(`BullMQ job is not registered in queue: ${input.queueName}/${input.jobName}`);
    }
  }

  private attachResolvedTraceIdToPayload<
    Q extends BullMqQueueName,
    J extends BullMqJobName<Q>,
  >(input: {
    readonly queueName: Q;
    readonly payload: BullMqJobPayload<Q, J>;
    readonly traceId: string;
  }): BullMqJobPayload<Q, J> {
    if (
      input.queueName !== 'ai-execution' &&
      input.queueName !== 'ai-workflow' &&
      input.queueName !== 'email'
    ) {
      return input.payload;
    }
    if (!this.isObjectRecord(input.payload)) {
      return input.payload;
    }
    return {
      ...(input.payload as Record<string, unknown>),
      traceId: input.traceId,
    };
  }

  private readTraceIdFromPayload(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') {
      return undefined;
    }
    const traceId = (payload as Record<string, unknown>).traceId;
    if (typeof traceId !== 'string') {
      return undefined;
    }
    const normalized = traceId.trim();
    return normalized || undefined;
  }

  private normalizeExplicitJobId(jobId?: string): string | undefined {
    if (jobId === undefined) {
      return undefined;
    }
    const normalized = jobId.trim();
    if (!normalized) {
      throw new Error('explicit_job_id_required');
    }
    return normalized;
  }

  private isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}

function normalizeBullMqJobState(rawState: JobState | 'unknown'): BullMqJobRuntimeState {
  switch (rawState) {
    case 'waiting':
    case 'prioritized':
    case 'waiting-children':
      return 'waiting';
    case 'active':
      return 'active';
    case 'delayed':
      return 'delayed';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
}
