// src/infrastructure/bullmq/queue-registry.ts
import type { JobsOptions } from 'bullmq';
import { BULLMQ_QUEUES, type BullMqQueueName } from './bullmq.constants';

export interface BullMqQueueRuntimePolicy {
  readonly concurrency: number;
  readonly limiter?: {
    readonly max: number;
    readonly duration: number;
  };
  readonly shutdownGraceMs: number;
}

export interface BullMqQueuePolicy {
  readonly queueName: BullMqQueueName;
  readonly defaultJobOptions: Readonly<
    Pick<JobsOptions, 'attempts' | 'backoff' | 'removeOnComplete' | 'removeOnFail'>
  >;
  readonly runtime: BullMqQueueRuntimePolicy;
}

export const BULLMQ_QUEUE_REGISTRY: Readonly<Record<BullMqQueueName, BullMqQueuePolicy>> = {
  [BULLMQ_QUEUES.EMAIL]: {
    queueName: BULLMQ_QUEUES.EMAIL,
    defaultJobOptions: {
      // 总尝试次数，首次 1 + 重试 1
      attempts: 2,
      // 失败后的退避策略：指数退避，首轮延迟 2000 ms
      backoff: { type: 'exponential', delay: 2000 },
      // 成功任务最多保留 100 条，控制 Redis 内存占用
      removeOnComplete: 100,
      // 失败任务最多保留 100 条，保留基础排障样本
      removeOnFail: 100,
    },
    runtime: {
      // Worker 并发数：同一时刻最多并行处理 2 个任务，降低自建邮件服务压力
      concurrency: 2,
      limiter: {
        // 限流窗口内最多处理 20 个任务，避免自建邮件服务突发拥塞
        max: 20,
        // 限流窗口时长 1000 ms
        duration: 1000,
      },
      // 停机时给 Worker 的优雅退出时间（毫秒），10 秒内尽量完成在途任务
      shutdownGraceMs: 10000,
    },
  },
  [BULLMQ_QUEUES.AI]: {
    queueName: BULLMQ_QUEUES.AI,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1500 },
      removeOnComplete: 200,
      removeOnFail: 1000,
    },
    runtime: {
      concurrency: 4,
      limiter: {
        max: 40,
        duration: 1000,
      },
      shutdownGraceMs: 12000,
    },
  },
  [BULLMQ_QUEUES.AI_WORKFLOW]: {
    queueName: BULLMQ_QUEUES.AI_WORKFLOW,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1500 },
      removeOnComplete: 200,
      removeOnFail: 1000,
    },
    runtime: {
      concurrency: 4,
      shutdownGraceMs: 12000,
    },
  },
  [BULLMQ_QUEUES.INTAKE_ANALYSIS]: {
    queueName: BULLMQ_QUEUES.INTAKE_ANALYSIS,
    defaultJobOptions: {
      // BullMQ 层的基建补投（瞬时故障 / 进程崩溃）：与用户主动重试（代次 0→1）完全独立，
      // 任何一次 BullMQ 重试都不会推进首析代次
      attempts: 3,
      backoff: { type: 'exponential', delay: 1500 },
      removeOnComplete: 200,
      removeOnFail: 1000,
    },
    runtime: {
      concurrency: 2,
      shutdownGraceMs: 12000,
    },
  },
};

export const BULLMQ_QUEUE_NAMES: ReadonlyArray<BullMqQueueName> = Object.values(BULLMQ_QUEUES);

export const BULLMQ_REGISTER_QUEUE_OPTIONS = BULLMQ_QUEUE_NAMES.map((queueName) => ({
  name: queueName,
}));
