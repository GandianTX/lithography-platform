// src/usecases/intake-analysis/consume-intake-analysis-job.usecase.spec.ts
// 首析 Worker 消费用例（注入测试替身）：业务状态、归属丢弃、受控失败与审计。

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { IntakeAnalysisStatus } from '@app-types/models/repair-request.types';
import type {
  IntakeAnalysisClaimResult,
  IntakeAnalysisFinishResult,
} from '@src/modules/lithography/lithography.types';
import type { IntakeAnalysisService } from '@src/modules/lithography/intake-analysis.service';
import type { AiProviderCallRecordService } from '@src/modules/ai-provider-call-record/ai-provider-call-record.service';
import type { AsyncTaskRecordService } from '@src/modules/async-task-record/async-task-record.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import type {
  RagDiagnosisClient,
  RagDiagnosisInput,
  RagDiagnosisResult,
} from '@src/usecases/common/ports/rag-diagnosis-client.contract';
import { ConsumeIntakeAnalysisJobUsecase } from './consume-intake-analysis-job.usecase';
import { IntakeAnalysisNonRetryableError } from './intake-analysis-worker.errors';
import type { ConsumeIntakeAnalysisJobProcessInput } from './intake-analysis-worker.types';

const transactionContext = Symbol('tx') as unknown as PersistenceTransactionContext;

type IntakeAnalysisServiceMock = {
  readonly claimForAnalysis: jest.Mock<Promise<IntakeAnalysisClaimResult>>;
  readonly finishIntakeAnalysis: jest.Mock<Promise<IntakeAnalysisFinishResult>>;
  readonly getIntakeForAnalysis: jest.Mock<
    Promise<{
      intake: {
        id: number;
        recordUuid: string;
        customerAccountId: number;
        customerOrganizationId: number;
        serviceOrganizationId: number;
        equipmentModelId: number;
        errorCode: string;
        faultDescription: string;
        fileId: string | null;
        analysisStatus: string;
        analysisGeneration: number;
        convertedRequestId: number | null;
        createdAt: Date;
      };
      modelCode: string;
    } | null>
  >;
};

type AsyncTaskRecordServiceMock = {
  readonly recordStarted: jest.Mock;
  readonly recordFinished: jest.Mock;
};

type ProviderCallServiceMock = {
  readonly createRecord: jest.Mock<Promise<{ id: number }>>;
};

type RagClientMock = {
  readonly diagnose: jest.Mock<Promise<RagDiagnosisResult>>;
};

const buildProcessInput = (
  overrides: Partial<ConsumeIntakeAnalysisJobProcessInput> = {},
): ConsumeIntakeAnalysisJobProcessInput => ({
  queueName: 'intake-analysis',
  jobName: 'analyze',
  jobId: 'intake-analysis:21:g0',
  traceId: 'trace-1',
  intakeId: 21,
  generationNo: 0,
  attemptsMade: 0,
  maxAttempts: 3,
  startedAt: new Date('2026-11-20T10:00:00.000Z'),
  enqueuedAt: new Date('2026-11-20T09:59:00.000Z'),
  ...overrides,
});

describe('ConsumeIntakeAnalysisJobUsecase.process', () => {
  let intakeAnalysisService: IntakeAnalysisServiceMock;
  let asyncTaskRecordService: AsyncTaskRecordServiceMock;
  let providerCallService: ProviderCallServiceMock;
  let ragClient: RagClientMock;
  let transactionRunner: TransactionRunner;
  let usecase: ConsumeIntakeAnalysisJobUsecase;

  beforeEach(() => {
    intakeAnalysisService = {
      claimForAnalysis: jest.fn().mockResolvedValue({
        kind: 'CLAIMED',
        intakeId: 21,
        generationNo: 0,
        attemptId: 501,
        startedAt: new Date('2026-11-20T10:00:00.000Z'),
      }),
      finishIntakeAnalysis: jest
        .fn()
        .mockResolvedValue({ kind: 'WRITTEN', intakeId: 21, generationNo: 0 }),
      getIntakeForAnalysis: jest.fn().mockResolvedValue({
        intake: {
          id: 21,
          recordUuid: '6f0d1c62-2c66-4b1e-9f1e-2f1f0d1c6a11',
          customerAccountId: 7,
          customerOrganizationId: 77,
          serviceOrganizationId: 88,
          equipmentModelId: 3,
          errorCode: 'E-100',
          faultDescription: 'x'.repeat(5000),
          fileId: 'file-id-should-not-be-sent',
          analysisStatus: IntakeAnalysisStatus.RUNNING,
          analysisGeneration: 0,
          convertedRequestId: 11,
          createdAt: new Date('2026-11-20T09:00:00.000Z'),
        },
        modelCode: 'LITHO-9000',
      }),
    };
    asyncTaskRecordService = {
      recordStarted: jest.fn().mockResolvedValue({ id: 1 }),
      recordFinished: jest.fn().mockResolvedValue({ id: 1 }),
    };
    providerCallService = {
      createRecord: jest.fn().mockResolvedValue({ id: 9 }),
    };
    ragClient = {
      diagnose: jest.fn().mockResolvedValue({
        ok: true,
        requestId: 'r1',
        text: '建议检查主控报警与光源模块。',
        visualization: null,
      }),
    };
    transactionRunner = {
      run: jest.fn(async (callback) => await callback(transactionContext)),
    };
    usecase = new ConsumeIntakeAnalysisJobUsecase(
      intakeAnalysisService as unknown as IntakeAnalysisService,
      asyncTaskRecordService as unknown as AsyncTaskRecordService,
      providerCallService as unknown as AiProviderCallRecordService,
      transactionRunner,
      ragClient,
    );
  });

  it('正常路径：认领 → 单次调用 → provider 审计 → 有效正文写回 SUCCEEDED', async () => {
    const result = await usecase.process(buildProcessInput());

    expect(result).toEqual({ accepted: true, intakeId: 21, generationNo: 0 });
    expect(ragClient.diagnose).toHaveBeenCalledTimes(1);
    expect(asyncTaskRecordService.recordStarted).toHaveBeenCalledWith({
      data: expect.objectContaining({
        queueName: 'intake-analysis',
        jobId: 'intake-analysis:21:g0',
        traceId: 'trace-1',
        bizType: 'intake_analysis',
        bizKey: 'trace-1',
        source: 'system',
        reason: 'worker_processing',
        attemptCount: 1,
        maxAttempts: 3,
      }),
    });

    const diagnosisInput = ragClient.diagnose.mock.calls[0][0] as RagDiagnosisInput;
    expect(
      diagnosisInput.question.startsWith('设备型号：LITHO-9000\n错误码：E-100\n故障现象：'),
    ).toBe(true);
    expect(diagnosisInput.question.length).toBeLessThanOrEqual(2000);
    expect(diagnosisInput.history).toEqual([]);
    expect(diagnosisInput.context).toMatchObject({
      mode: 'INDEPENDENT',
      equipmentModelCode: 'LITHO-9000',
      fault: expect.objectContaining({ mainError: null, description: expect.any(String) }),
    });
    // fault.description 传输副本 ≤ 4000，且不带附件/账号信息
    expect((diagnosisInput.context.fault?.description ?? '').length).toBeLessThanOrEqual(4000);
    expect(JSON.stringify(diagnosisInput)).not.toContain('file-id-should-not-be-sent');

    expect(providerCallService.createRecord).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: 'rag-diagnosis',
        providerStatus: 'succeeded',
        source: 'system',
        bizType: 'intake_analysis',
      }),
    });
    expect(intakeAnalysisService.finishIntakeAnalysis).toHaveBeenCalledWith({
      input: {
        intakeId: 21,
        generationNo: 0,
        attemptId: 501,
        outcome: {
          kind: 'SUCCEEDED',
          outputText: '建议检查主控报警与光源模块。',
          providerCallId: 9,
        },
      },
      transactionContext,
    });
  });

  it('空正文按明确失败写回（RAG_EMPTY_RESPONSE），不算成功', async () => {
    ragClient.diagnose.mockResolvedValueOnce({
      ok: true,
      requestId: 'r1',
      text: '   ',
      visualization: null,
    });

    await usecase.process(buildProcessInput());

    expect(intakeAnalysisService.finishIntakeAnalysis).toHaveBeenCalledWith({
      input: expect.objectContaining({
        attemptId: 501,
        outcome: { kind: 'FAILED', failureReason: 'RAG_EMPTY_RESPONSE', providerCallId: 9 },
      }),
      transactionContext,
    });
  });

  it('模型侧失败码映射为受控 failure_reason（RAG_TIMEOUT），不抛异常', async () => {
    ragClient.diagnose.mockResolvedValueOnce({ ok: false, requestId: 'r1', code: 'TIMEOUT' });

    const result = await usecase.process(buildProcessInput());

    expect(result.accepted).toBe(true);
    expect(intakeAnalysisService.finishIntakeAnalysis).toHaveBeenCalledWith({
      input: expect.objectContaining({
        outcome: { kind: 'FAILED', failureReason: 'RAG_TIMEOUT', providerCallId: 9 },
      }),
      transactionContext,
    });
    expect(providerCallService.createRecord).toHaveBeenCalledWith({
      data: expect.objectContaining({ providerStatus: 'failed', normalizedErrorCode: 'TIMEOUT' }),
    });
  });

  it('租约有效期内（另一执行在处理）：不可重试失败且不调用模型', async () => {
    intakeAnalysisService.claimForAnalysis.mockResolvedValueOnce({
      kind: 'LEASE_ACTIVE',
      intakeId: 21,
      generationNo: 0,
    });

    await expect(usecase.process(buildProcessInput())).rejects.toMatchObject({
      code: 'INTAKE_ANALYSIS_LEASE_ACTIVE',
    });
    expect(ragClient.diagnose).not.toHaveBeenCalled();
    expect(intakeAnalysisService.finishIntakeAnalysis).not.toHaveBeenCalled();
  });

  it('已终态（ALREADY_SUCCEEDED）：直接接受，不产生第二次执行', async () => {
    intakeAnalysisService.claimForAnalysis.mockResolvedValueOnce({
      kind: 'ALREADY_SUCCEEDED',
      intakeId: 21,
      generationNo: 0,
    });

    const result = await usecase.process(buildProcessInput());

    expect(result.accepted).toBe(true);
    expect(ragClient.diagnose).not.toHaveBeenCalled();
  });

  it('已失败（ALREADY_FAILED）：不可重试失败，绝不再次调用模型', async () => {
    intakeAnalysisService.claimForAnalysis.mockResolvedValueOnce({
      kind: 'ALREADY_FAILED',
      intakeId: 21,
      generationNo: 0,
    });

    await expect(usecase.process(buildProcessInput())).rejects.toMatchObject({
      code: 'INTAKE_ANALYSIS_ALREADY_FAILED',
    });
    expect(ragClient.diagnose).not.toHaveBeenCalled();
    expect(intakeAnalysisService.finishIntakeAnalysis).not.toHaveBeenCalled();
    expect(providerCallService.createRecord).not.toHaveBeenCalled();
  });

  it('代次不匹配（重试后旧投递到达）：不可重试失败，不调用模型', async () => {
    intakeAnalysisService.claimForAnalysis.mockResolvedValueOnce({
      kind: 'NOT_EXECUTABLE',
      intakeId: 21,
      reason: 'GENERATION_MISMATCH',
    });

    await expect(usecase.process(buildProcessInput())).rejects.toBeInstanceOf(
      IntakeAnalysisNonRetryableError,
    );
    expect(ragClient.diagnose).not.toHaveBeenCalled();
  });

  it('jobId 与 payload 不一致：不可重试失败且不写账本 started', async () => {
    await expect(
      usecase.process(buildProcessInput({ jobId: 'intake-analysis:99:g1' })),
    ).rejects.toMatchObject({ code: 'INTAKE_ANALYSIS_JOB_MISMATCH' });
    expect(asyncTaskRecordService.recordStarted).not.toHaveBeenCalled();
  });

  it('旧执行迟到（OWNERSHIP_LOST）：结果丢弃、返回 accepted，不抛错', async () => {
    intakeAnalysisService.finishIntakeAnalysis.mockResolvedValueOnce({
      kind: 'OWNERSHIP_LOST',
      intakeId: 21,
      generationNo: 0,
    });

    const result = await usecase.process(buildProcessInput());

    expect(result.accepted).toBe(true);
    expect(ragClient.diagnose).toHaveBeenCalledTimes(1);
  });

  it('报修已删除（REJECTED DELETED）：接受任务但不复活任何状态', async () => {
    intakeAnalysisService.finishIntakeAnalysis.mockResolvedValueOnce({
      kind: 'REJECTED',
      intakeId: 21,
      reason: 'DELETED',
    });

    const result = await usecase.process(buildProcessInput());

    expect(result.accepted).toBe(true);
    expect(intakeAnalysisService.finishIntakeAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ attemptId: 501, outcome: expect.anything() }),
      }),
    );
  });
});

describe('ConsumeIntakeAnalysisJobUsecase.complete / fail', () => {
  let asyncTaskRecordService: AsyncTaskRecordServiceMock;
  let usecase: ConsumeIntakeAnalysisJobUsecase;

  beforeEach(() => {
    asyncTaskRecordService = {
      recordStarted: jest.fn(),
      recordFinished: jest.fn().mockResolvedValue({ id: 1 }),
    };
    usecase = new ConsumeIntakeAnalysisJobUsecase(
      {} as unknown as IntakeAnalysisService,
      asyncTaskRecordService as unknown as AsyncTaskRecordService,
      {} as unknown as AiProviderCallRecordService,
      { run: jest.fn() },
      {} as unknown as RagDiagnosisClient,
    );
  });

  it('complete 写 succeeded / worker_completed 账本终态', async () => {
    await usecase.complete({
      queueName: 'intake-analysis',
      jobName: 'analyze',
      jobId: 'intake-analysis:21:g0',
      traceId: 'trace-1',
      attemptsMade: 1,
      maxAttempts: 3,
      finishedAt: new Date('2026-11-20T10:01:00.000Z'),
    });

    expect(asyncTaskRecordService.recordFinished).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'succeeded', reason: 'worker_completed' }),
    });
  });

  it('fail 只写账本终态，不推进 intake 状态（恢复交给补投与租约接管）', async () => {
    await usecase.fail({
      queueName: 'intake-analysis',
      jobName: 'analyze',
      jobId: 'intake-analysis:21:g0',
      traceId: 'trace-1',
      attemptsMade: 1,
      maxAttempts: 3,
      reason: 'db_down',
      finishedAt: new Date('2026-11-20T10:01:00.000Z'),
    });

    expect(asyncTaskRecordService.recordFinished).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'failed',
        reason: expect.stringContaining('worker_failed:db_down'),
      }),
    });
  });

  it('永久错误（不可重试码）落 worker_permanent 受控终结，不与临时故障混同', async () => {
    await usecase.fail({
      queueName: 'intake-analysis',
      jobName: 'analyze',
      jobId: 'intake-analysis:21:g0',
      traceId: 'trace-1',
      attemptsMade: 3,
      maxAttempts: 3,
      reason: 'intake_analysis_attempt_state_inconsistent',
      nonRetryableCode: 'INTAKE_ANALYSIS_ATTEMPT_STATE_INCONSISTENT',
      finishedAt: new Date('2026-11-20T10:01:00.000Z'),
    });

    expect(asyncTaskRecordService.recordFinished).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'failed',
        reason: 'worker_permanent:INTAKE_ANALYSIS_ATTEMPT_STATE_INCONSISTENT',
      }),
    });
  });

  it('可自愈的不可重试码仍按临时故障记录（补投重建 payload 后可恢复）', async () => {
    await usecase.fail({
      queueName: 'intake-analysis',
      jobName: 'analyze',
      jobId: 'intake-analysis:21:g0',
      traceId: 'trace-1',
      attemptsMade: 1,
      maxAttempts: 3,
      reason: 'intake_analysis_job_mismatch',
      nonRetryableCode: 'INTAKE_ANALYSIS_JOB_MISMATCH',
      finishedAt: new Date('2026-11-20T10:01:00.000Z'),
    });

    expect(asyncTaskRecordService.recordFinished).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'failed',
        reason: 'worker_failed:intake_analysis_job_mismatch',
      }),
    });
  });
});
