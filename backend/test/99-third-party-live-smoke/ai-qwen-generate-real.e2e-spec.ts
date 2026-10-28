import { LoginTypeEnum } from '@app-types/models/account.types';
import { DomainError, THIRDPARTY_ERROR } from '@core/common/errors/domain-error';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { ApiModule } from '@src/bootstraps/api/api.module';
import { WorkerModule } from '@src/bootstraps/worker/worker.module';
import { BULLMQ_QUEUES } from '@src/infrastructure/bullmq/bullmq.constants';
import { BullMqWorkerRuntime } from '@src/infrastructure/bullmq/worker.runtime';
import { AiProviderCallRecordEntity } from '@src/modules/ai-provider-call-record/ai-provider-call-record.entity';
import { AsyncTaskRecordEntity } from '@src/modules/async-task-record/async-task-record.entity';
import type { AsyncTaskRecordStatus } from '@src/modules/async-task-record/async-task-record.types';
import { TokenHelper } from '@src/modules/auth/token.helper';
import { Queue } from 'bullmq';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { login } from '../utils/e2e-graphql-utils';
import { createOwnedResourceLedger, runGuardedSpecCleanup } from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import {
  buildTestAccountResidue,
  seedTestAccounts,
  testAccountsConfig,
} from '../utils/test-accounts';

type FinalJobState = 'completed' | 'failed';

const SHOULD_RUN_REAL_AI = process.env.RUN_REAL_AI_E2E === 'true';
const HAS_QWEN_BASE_URL = (process.env.QWEN_BASE_URL ?? '').trim().length > 0;
const HAS_QWEN_API_KEY = (process.env.QWEN_API_KEY ?? '').trim().length > 0;
const HAS_REQUIRED_QWEN_CONFIG = HAS_QWEN_BASE_URL && HAS_QWEN_API_KEY;
const REAL_AI_DESCRIBE = SHOULD_RUN_REAL_AI && HAS_REQUIRED_QWEN_CONFIG ? describe : describe.skip;
const SHOULD_RUN_REAL_AI_AUTH_FAIL = process.env.RUN_REAL_AI_AUTH_FAIL_E2E === 'true';
const HAS_QWEN_AUTH_FAIL_API_KEY = (process.env.QWEN_AUTH_FAIL_API_KEY ?? '').trim().length > 0;
const HAS_REQUIRED_QWEN_AUTH_FAIL_CONFIG = HAS_QWEN_BASE_URL && HAS_QWEN_AUTH_FAIL_API_KEY;
const REAL_AI_AUTH_FAIL_DESCRIBE =
  SHOULD_RUN_REAL_AI_AUTH_FAIL && HAS_REQUIRED_QWEN_AUTH_FAIL_CONFIG ? describe : describe.skip;

const resolveRequiredEnv = (key: string): string => {
  const value = (process.env[key] ?? '').trim();
  if (!value) {
    throw new DomainError(THIRDPARTY_ERROR.INVALID_PARAMS, `${key} is required`);
  }
  return value;
};

const QUEUE_AI_GENERATE_MUTATION = `
  mutation QueueAiGenerate($input: QueueAiGenerateInput!) {
    queueAiGenerate(input: $input) {
      queued
      jobId
      traceId
    }
  }
`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitJobFinalState = async (input: {
  readonly queue: Queue;
  readonly jobId: string;
  readonly timeoutMs: number;
  readonly pollMs: number;
}): Promise<{
  readonly state: FinalJobState;
  readonly returnvalue: unknown;
  readonly failedReason: string | undefined;
}> => {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const job = await input.queue.getJob(input.jobId);
    if (job) {
      const state = await job.getState();
      if (state === 'completed' || state === 'failed') {
        return {
          state,
          returnvalue: job.returnvalue,
          failedReason: job.failedReason,
        };
      }
    }
    await sleep(input.pollMs);
  }
  throw new Error(`AI job did not reach final state in time: ${input.jobId}`);
};

const waitAsyncTaskRecord = async (input: {
  readonly dataSource: DataSource;
  readonly queueName: string;
  readonly jobId: string;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly statuses?: ReadonlyArray<AsyncTaskRecordStatus>;
}): Promise<AsyncTaskRecordEntity> => {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const record = await input.dataSource.getRepository(AsyncTaskRecordEntity).findOne({
      where: { queueName: input.queueName, jobId: input.jobId },
    });
    if (record && (!input.statuses || input.statuses.includes(record.status))) {
      return record;
    }
    await sleep(input.pollMs);
  }
  throw new Error(`AI async task record did not reach expected state in time: ${input.jobId}`);
};

const countAsyncTaskRecords = async (input: {
  readonly dataSource: DataSource;
  readonly queueName: string;
  readonly jobId: string;
}): Promise<number> => {
  return await input.dataSource.getRepository(AsyncTaskRecordEntity).count({
    where: {
      queueName: input.queueName,
      jobId: input.jobId,
    },
  });
};

const waitLatestProviderCallRecord = async (input: {
  readonly dataSource: DataSource;
  readonly traceId: string;
  readonly status?: 'succeeded' | 'failed';
  readonly timeoutMs: number;
  readonly pollMs: number;
}): Promise<AiProviderCallRecordEntity> => {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const where =
      input.status === undefined
        ? { traceId: input.traceId }
        : { traceId: input.traceId, providerStatus: input.status };
    const record = await input.dataSource.getRepository(AiProviderCallRecordEntity).findOne({
      where,
      order: { id: 'DESC' },
    });
    if (record) {
      return record;
    }
    await sleep(input.pollMs);
  }
  throw new Error(`AI provider call record did not reach expected state in time: ${input.traceId}`);
};

const queueAiGenerate = async (input: {
  readonly app: INestApplication;
  readonly token: string;
  readonly provider: 'qwen';
  readonly model: string;
  readonly prompt: string;
  readonly dedupKey: string;
  readonly traceId: string;
  readonly metadata?: Readonly<Record<string, string>>;
}): Promise<{
  readonly queued: boolean;
  readonly jobId: string;
  readonly traceId: string;
}> => {
  const response = await request(input.app.getHttpServer())
    .post('/graphql')
    .set('Authorization', `Bearer ${input.token}`)
    .send({
      query: QUEUE_AI_GENERATE_MUTATION,
      variables: {
        input: {
          provider: input.provider,
          model: input.model,
          prompt: input.prompt,
          dedupKey: input.dedupKey,
          traceId: input.traceId,
          metadata: input.metadata,
        },
      },
    })
    .expect(200);

  expect(response.body.errors).toBeUndefined();
  return response.body.data.queueAiGenerate as {
    readonly queued: boolean;
    readonly jobId: string;
    readonly traceId: string;
  };
};

const isUpstreamFailure = (message: string): boolean => {
  return /ai_provider_(config_missing|auth_failed|timeout|upstream_5xx|request_failed|unknown_error)/.test(
    message,
  );
};

const assertFailureCategory = (input: {
  readonly failedReason?: string;
  readonly taskReason?: string | null;
}): never => {
  const merged = [input.failedReason ?? '', input.taskReason ?? ''].join('|');
  if (isUpstreamFailure(merged)) {
    throw new Error(`上游不可用或鉴权失败: ${merged}`);
  }
  throw new Error(`业务链路异常: ${merged}`);
};

REAL_AI_DESCRIBE('真实 Qwen generate 闭环（受控 e2e）', () => {
  let apiApp: INestApplication;
  let workerApp: INestApplicationContext;
  let workerRuntime: BullMqWorkerRuntime;
  let aiQueue: Queue;
  let dataSource: DataSource;
  let staffPrimaryToken: string;
  let staffPrimaryAccountId: number;
  let staffPrimaryActiveRole: string;

  const ownership = createOwnedResourceLedger();
  const residueAccounts = buildTestAccountResidue(['staffPrimary']);

  beforeAll(async () => {
    if ((process.env.AI_PROVIDER_MODE ?? '').trim().toLowerCase() !== 'remote') {
      throw new Error('RUN_REAL_AI_E2E=true 时必须设置 AI_PROVIDER_MODE=remote');
    }
    initGraphQLSchema();
    const apiModuleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    apiApp = apiModuleFixture.createNestApplication();
    await apiApp.init();

    workerApp = await NestFactory.createApplicationContext(WorkerModule);
    aiQueue = apiApp.get<Queue>(getQueueToken(BULLMQ_QUEUES.AI));
    workerRuntime = workerApp.get(BullMqWorkerRuntime);
    dataSource = apiApp.get(DataSource);
    await workerRuntime.start();

    await runGuardedSpecCleanup({
      dataSource,
      helper: 'ai-qwen-generate-real.e2e beforeAll',
      residue: { accounts: residueAccounts },
    });
    await seedTestAccounts({ dataSource, includeKeys: ['staffPrimary'], ownership });
    staffPrimaryToken = await login({
      app: apiApp,
      loginName: testAccountsConfig.staffPrimary.loginName,
      loginPassword: testAccountsConfig.staffPrimary.loginPassword,
      type: LoginTypeEnum.PASSWORD,
    });
    const tokenHelper = apiApp.get(TokenHelper);
    const staffPrimaryPayload = tokenHelper.decodeToken({ token: staffPrimaryToken });
    if (!staffPrimaryPayload?.sub) {
      throw new Error('无法从 staff primary token 获取 sub');
    }
    staffPrimaryAccountId = staffPrimaryPayload.sub;
    staffPrimaryActiveRole = String(staffPrimaryPayload.activeRole ?? '');
    if (!staffPrimaryActiveRole) {
      throw new Error('无法从 staff primary token 获取 activeRole');
    }
  }, 120000);

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: () =>
        runGuardedSpecCleanup({
          dataSource,
          helper: 'ai-qwen-generate-real.e2e afterAll',
          owned: ownership,
          residue: { accounts: residueAccounts },
        }),
      closeApp: async () => {
        if (workerApp) {
          await workerApp.close();
        }
        if (apiApp) {
          await apiApp.close();
        }
      },
    });
  });

  it('应完成 queueAiGenerate 到 worker_completed 的真实 qwen 闭环', async () => {
    const now = Date.now();
    const marker = `REAL_QWEN_E2E_${now}`;
    const dedupKey = `e2e-real-qwen-generate-${now}`;
    const traceId = `e2e-real-qwen-generate-trace-${now}`;
    const model = resolveRequiredEnv('QWEN_GENERATE_MODEL');
    const prompt = `请仅回复 ${marker}`;

    const enqueue = await queueAiGenerate({
      app: apiApp,
      token: staffPrimaryToken,
      provider: 'qwen',
      model,
      prompt,
      dedupKey,
      traceId,
      metadata: {
        source: 'e2e-real-ai-generate',
        purpose: 'smoke',
      },
    });

    expect(enqueue.queued).toBe(true);
    expect(enqueue.jobId).toBe(dedupKey);

    const finalState = await waitJobFinalState({
      queue: aiQueue,
      jobId: enqueue.jobId,
      timeoutMs: 120000,
      pollMs: 300,
    });

    const finalRecord = await waitAsyncTaskRecord({
      dataSource,
      queueName: BULLMQ_QUEUES.AI,
      jobId: enqueue.jobId,
      timeoutMs: 30000,
      pollMs: 300,
      statuses: ['succeeded', 'failed'],
    });

    if (finalState.state === 'failed' || finalRecord.status === 'failed') {
      assertFailureCategory({
        failedReason: finalState.failedReason,
        taskReason: finalRecord.reason,
      });
    }

    expect(finalState.state).toBe('completed');
    expect(finalRecord.status).toBe('succeeded');
    expect(finalRecord.bizType).toBe('ai_generation');
    expect(finalRecord.reason).toBe('worker_completed');
    expect(finalRecord.actorAccountId).toBe(staffPrimaryAccountId);
    expect(finalRecord.actorActiveRole).toBe(staffPrimaryActiveRole);
    expect(finalRecord.jobId).toBe(dedupKey);
    expect(finalRecord.traceId).toBe(traceId);

    const returnvalue = finalState.returnvalue as {
      readonly accepted?: boolean;
      readonly providerJobId?: string;
      readonly outputText?: string;
    };
    const providerJobId = (returnvalue.providerJobId ?? '').trim();
    const outputText = (returnvalue.outputText ?? '').trim();
    expect(returnvalue.accepted).toBe(true);
    expect(providerJobId.startsWith('qwen:')).toBe(true);
    expect(outputText.length).toBeGreaterThan(0);
    expect(outputText).not.toBe('[empty_output]');
    expect(outputText).toContain(marker);

    const providerCallRecord = await waitLatestProviderCallRecord({
      dataSource,
      traceId,
      status: 'succeeded',
      timeoutMs: 30000,
      pollMs: 300,
    });
    expect(providerCallRecord.asyncTaskRecordId).toBe(finalRecord.id);
    expect(providerCallRecord.providerStatus).toBe('succeeded');
    expect(providerCallRecord.provider).toBe('qwen');
    expect(providerCallRecord.model).toBe(model);
    expect(providerCallRecord.taskType).toBe('generate');
    if (providerCallRecord.providerRequestId !== null) {
      expect(providerCallRecord.providerRequestId.trim().length).toBeGreaterThan(0);
    }
  }, 180000);

  it('相同 dedupKey 重复命中应复用原 jobId 与 actor 且不新增记录', async () => {
    const now = Date.now();
    const dedupKey = `e2e-real-qwen-generate-dedup-${now}`;
    const firstTraceId = `e2e-real-qwen-generate-dedup-first-${now}`;
    const secondTraceId = `e2e-real-qwen-generate-dedup-second-${now}`;
    const model = resolveRequiredEnv('QWEN_GENERATE_MODEL');

    const firstEnqueue = await queueAiGenerate({
      app: apiApp,
      token: staffPrimaryToken,
      provider: 'qwen',
      model,
      prompt: `请仅回复 REAL_QWEN_E2E_DEDUP_FIRST_${now}`,
      dedupKey,
      traceId: firstTraceId,
      metadata: {
        source: 'e2e-real-ai-generate',
        purpose: 'smoke-dedup-first',
      },
    });
    const secondEnqueue = await queueAiGenerate({
      app: apiApp,
      token: staffPrimaryToken,
      provider: 'qwen',
      model,
      prompt: `请仅回复 REAL_QWEN_E2E_DEDUP_SECOND_${now}`,
      dedupKey,
      traceId: secondTraceId,
      metadata: {
        source: 'e2e-real-ai-generate',
        purpose: 'smoke-dedup-second',
      },
    });

    expect(firstEnqueue.queued).toBe(true);
    expect(secondEnqueue.queued).toBe(true);
    expect(firstEnqueue.jobId).toBe(dedupKey);
    expect(secondEnqueue.jobId).toBe(dedupKey);
    expect(firstEnqueue.traceId).toBe(firstTraceId);
    expect(secondEnqueue.traceId).toBe(firstTraceId);

    const finalState = await waitJobFinalState({
      queue: aiQueue,
      jobId: dedupKey,
      timeoutMs: 120000,
      pollMs: 300,
    });
    const finalRecord = await waitAsyncTaskRecord({
      dataSource,
      queueName: BULLMQ_QUEUES.AI,
      jobId: dedupKey,
      timeoutMs: 30000,
      pollMs: 300,
      statuses: ['succeeded', 'failed'],
    });
    if (finalState.state === 'failed' || finalRecord.status === 'failed') {
      assertFailureCategory({
        failedReason: finalState.failedReason,
        taskReason: finalRecord.reason,
      });
    }

    expect(finalState.state).toBe('completed');
    expect(finalRecord.status).toBe('succeeded');
    expect(finalRecord.reason).toBe('worker_completed');
    expect(finalRecord.bizType).toBe('ai_generation');
    expect(finalRecord.traceId).toBe(firstTraceId);
    expect(finalRecord.actorAccountId).toBe(staffPrimaryAccountId);
    expect(finalRecord.actorActiveRole).toBe(staffPrimaryActiveRole);

    const recordCount = await countAsyncTaskRecords({
      dataSource,
      queueName: BULLMQ_QUEUES.AI,
      jobId: dedupKey,
    });
    expect(recordCount).toBe(1);
  }, 180000);
});

REAL_AI_AUTH_FAIL_DESCRIBE('真实 Qwen generate 鉴权失败分类（受控 e2e）', () => {
  let apiApp: INestApplication;
  let workerApp: INestApplicationContext;
  let workerRuntime: BullMqWorkerRuntime;
  let aiQueue: Queue;
  let dataSource: DataSource;
  let staffPrimaryToken: string;
  let staffPrimaryAccountId: number;
  let staffPrimaryActiveRole: string;
  let originalQwenApiKey: string | undefined;

  const ownership = createOwnedResourceLedger();
  const residueAccounts = buildTestAccountResidue(['staffPrimary']);

  beforeAll(async () => {
    if ((process.env.AI_PROVIDER_MODE ?? '').trim().toLowerCase() !== 'remote') {
      throw new Error('RUN_REAL_AI_AUTH_FAIL_E2E=true 时必须设置 AI_PROVIDER_MODE=remote');
    }
    const authFailApiKey = (process.env.QWEN_AUTH_FAIL_API_KEY ?? '').trim();
    if (!authFailApiKey) {
      throw new Error('RUN_REAL_AI_AUTH_FAIL_E2E=true 时必须设置 QWEN_AUTH_FAIL_API_KEY');
    }

    originalQwenApiKey = process.env.QWEN_API_KEY;
    process.env.QWEN_API_KEY = authFailApiKey;

    initGraphQLSchema();
    const apiModuleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    apiApp = apiModuleFixture.createNestApplication();
    await apiApp.init();

    workerApp = await NestFactory.createApplicationContext(WorkerModule);
    aiQueue = apiApp.get<Queue>(getQueueToken(BULLMQ_QUEUES.AI));
    workerRuntime = workerApp.get(BullMqWorkerRuntime);
    dataSource = apiApp.get(DataSource);
    await workerRuntime.start();

    await runGuardedSpecCleanup({
      dataSource,
      helper: 'ai-qwen-generate-auth-fail.e2e beforeAll',
      residue: { accounts: residueAccounts },
    });
    await seedTestAccounts({ dataSource, includeKeys: ['staffPrimary'], ownership });
    staffPrimaryToken = await login({
      app: apiApp,
      loginName: testAccountsConfig.staffPrimary.loginName,
      loginPassword: testAccountsConfig.staffPrimary.loginPassword,
      type: LoginTypeEnum.PASSWORD,
    });
    const tokenHelper = apiApp.get(TokenHelper);
    const staffPrimaryPayload = tokenHelper.decodeToken({ token: staffPrimaryToken });
    if (!staffPrimaryPayload?.sub) {
      throw new Error('无法从 staff primary token 获取 sub');
    }
    staffPrimaryAccountId = staffPrimaryPayload.sub;
    staffPrimaryActiveRole = String(staffPrimaryPayload.activeRole ?? '');
    if (!staffPrimaryActiveRole) {
      throw new Error('无法从 staff primary token 获取 activeRole');
    }
  }, 120000);

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: () =>
        runGuardedSpecCleanup({
          dataSource,
          helper: 'ai-qwen-generate-auth-fail.e2e afterAll',
          owned: ownership,
          residue: { accounts: residueAccounts },
        }),
      finalize: () => {
        process.env.QWEN_API_KEY = originalQwenApiKey;
      },
      closeApp: async () => {
        if (workerApp) {
          await workerApp.close();
        }
        if (apiApp) {
          await apiApp.close();
        }
      },
    });
  });

  it('应落 failed 且归类为 ai_provider_auth_failed', async () => {
    const now = Date.now();
    const dedupKey = `e2e-real-qwen-auth-fail-${now}`;
    const traceId = `e2e-real-qwen-auth-fail-trace-${now}`;
    const model = resolveRequiredEnv('QWEN_GENERATE_MODEL');

    const enqueue = await queueAiGenerate({
      app: apiApp,
      token: staffPrimaryToken,
      provider: 'qwen',
      model,
      prompt: `请仅回复 REAL_QWEN_E2E_AUTH_FAIL_${now}`,
      dedupKey,
      traceId,
      metadata: {
        source: 'e2e-real-ai-generate',
        purpose: 'smoke-auth-fail',
      },
    });

    expect(enqueue.queued).toBe(true);
    expect(enqueue.jobId).toBe(dedupKey);

    const finalState = await waitJobFinalState({
      queue: aiQueue,
      jobId: enqueue.jobId,
      timeoutMs: 120000,
      pollMs: 300,
    });
    const finalRecord = await waitAsyncTaskRecord({
      dataSource,
      queueName: BULLMQ_QUEUES.AI,
      jobId: enqueue.jobId,
      timeoutMs: 30000,
      pollMs: 300,
      statuses: ['failed', 'succeeded'],
    });

    expect(finalState.state).toBe('failed');
    expect(finalRecord.status).toBe('failed');
    expect(finalRecord.bizType).toBe('ai_generation');
    expect(finalRecord.actorAccountId).toBe(staffPrimaryAccountId);
    expect(finalRecord.actorActiveRole).toBe(staffPrimaryActiveRole);
    expect(finalRecord.traceId).toBe(traceId);
    expect(finalRecord.reason ?? '').toContain('ai_provider_auth_failed');
    expect(finalState.failedReason ?? '').toContain('ai_provider_auth_failed');

    const providerCallRecord = await waitLatestProviderCallRecord({
      dataSource,
      traceId,
      status: 'failed',
      timeoutMs: 30000,
      pollMs: 300,
    });
    expect(providerCallRecord.asyncTaskRecordId).toBe(finalRecord.id);
    expect(providerCallRecord.providerStatus).toBe('failed');
    expect(providerCallRecord.provider).toBe('qwen');
    expect(providerCallRecord.model).toBe(model);
    expect(providerCallRecord.taskType).toBe('generate');
    expect(providerCallRecord.normalizedErrorCode ?? '').toContain('ai_provider_auth_failed');
    if (providerCallRecord.providerErrorCode !== null) {
      expect(providerCallRecord.providerErrorCode.length).toBeGreaterThan(0);
    }
  }, 180000);
});
