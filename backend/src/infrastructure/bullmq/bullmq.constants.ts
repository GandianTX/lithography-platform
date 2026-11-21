// src/infrastructure/bullmq/bullmq.constants.ts
export const BULLMQ_QUEUES = {
  EMAIL: 'email',
  AI: 'ai-execution',
  AI_WORKFLOW: 'ai-workflow',
  INTAKE_ANALYSIS: 'intake-analysis',
} as const;

export type BullMqQueueName = (typeof BULLMQ_QUEUES)[keyof typeof BULLMQ_QUEUES];

export const BULLMQ_JOBS = {
  EMAIL: {
    SEND: 'send',
  },
  AI: {
    GENERATE: 'generate',
    EMBED: 'embed',
    WORKFLOW: 'workflow',
  },
  INTAKE_ANALYSIS: {
    ANALYZE: 'analyze',
  },
} as const;

export type BullMqEmailJobName = (typeof BULLMQ_JOBS.EMAIL)[keyof typeof BULLMQ_JOBS.EMAIL];
export type BullMqAiJobName = (typeof BULLMQ_JOBS.AI)[keyof typeof BULLMQ_JOBS.AI];
export const BULLMQ_QUEUE_JOBS: Readonly<Record<BullMqQueueName, ReadonlyArray<string>>> = {
  [BULLMQ_QUEUES.EMAIL]: Object.values(BULLMQ_JOBS.EMAIL),
  [BULLMQ_QUEUES.AI]: [BULLMQ_JOBS.AI.GENERATE, BULLMQ_JOBS.AI.EMBED],
  [BULLMQ_QUEUES.AI_WORKFLOW]: [BULLMQ_JOBS.AI.WORKFLOW],
  [BULLMQ_QUEUES.INTAKE_ANALYSIS]: [BULLMQ_JOBS.INTAKE_ANALYSIS.ANALYZE],
};
