// src/usecases/repair-request/retry-intake-analysis.usecase.spec.ts
// 首析主动重试（替身注入）：唯一一次 0→1、本人核权、服务端事实复核、
// 并发/重复拒绝、投递观测与不泄露内部标识。
//
// 覆盖的复核项（与详情页展示资格同一 core 策略）：
// 本人、未删除、当前代次、可信账本、最新实际结果（当前代次尝试行 FAILED 且
// 记录受控失败原因）与执行归属。失败真假只看原稿/尝试行事实，
// 不看账本 failed 或 worker_permanent: 前缀。

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  DomainError,
  PERMISSION_ERROR,
  REPAIR_REQUEST_ERROR,
} from '@src/core/common/errors/domain-error';
import type { AsyncTaskRecordQueryService } from '@src/modules/async-task-record/queries/async-task-record.query.service';
import type { AsyncTaskRecordService } from '@src/modules/async-task-record/async-task-record.service';
import type { IntakeAnalysisService } from '@src/modules/lithography/intake-analysis.service';
import type { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import type { DeliverIntakeAnalysisUsecase } from '@src/usecases/repair-request/deliver-intake-analysis.usecase';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { RetryIntakeAnalysisUsecase } from './retry-intake-analysis.usecase';
import type { RetryIntakeAnalysisCommand } from './retry-intake-analysis.types';

const transactionContext = Symbol('tx') as unknown as PersistenceTransactionContext;

const customerSession: UsecaseSession = { accountId: 7, roles: ['CUSTOMER'] };

/** 第 0 代明确模型失败的可重试事实（默认） */
const eligibleRetryFacts = {
  intakeCustomerAccountId: 7,
  intakeDeleted: false,
  convertedRequestId: 11,
  generation: 0,
  status: 'FAILED',
  attemptGenerationNo: 0,
  attemptStatus: 'FAILED',
  attemptFailureReasonRecorded: true,
};

describe('RetryIntakeAnalysisUsecase', () => {
  let repairRequestService: { findSnapshotById: jest.Mock };
  let intakeAnalysisService: {
    loadRetryFacts: jest.Mock;
    bumpAnalysisGenerationForRetry: jest.Mock;
  };
  let asyncTaskRecordService: { recordEnqueued: jest.Mock };
  let asyncTaskRecordQueryService: { findByQueueJob: jest.Mock };
  let deliverUsecase: { execute: jest.Mock };
  let transactionRunner: TransactionRunner;
  let usecase: RetryIntakeAnalysisUsecase;

  const buildCommand = (
    overrides: Partial<RetryIntakeAnalysisCommand> = {},
  ): RetryIntakeAnalysisCommand => ({
    session: customerSession,
    requestId: 11,
    ...overrides,
  });

  const expectRejectedWithoutSideEffects = async (code: string): Promise<void> => {
    await expect(usecase.execute(buildCommand())).rejects.toMatchObject({ code });
    expect(intakeAnalysisService.bumpAnalysisGenerationForRetry).not.toHaveBeenCalled();
    expect(asyncTaskRecordService.recordEnqueued).not.toHaveBeenCalled();
    expect(deliverUsecase.execute).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    repairRequestService = {
      findSnapshotById: jest.fn().mockResolvedValue({
        id: 11,
        requestNo: 'RR20260901',
        customerAccountId: 7,
        isAccepted: false,
        deprecated: false,
        intakeId: 21,
      }),
    };
    intakeAnalysisService = {
      loadRetryFacts: jest.fn().mockResolvedValue(eligibleRetryFacts),
      bumpAnalysisGenerationForRetry: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    asyncTaskRecordService = { recordEnqueued: jest.fn().mockResolvedValue({ id: 1 }) };
    asyncTaskRecordQueryService = {
      findByQueueJob: jest.fn().mockResolvedValue({ id: 9, status: 'failed' }),
    };
    deliverUsecase = {
      execute: jest
        .fn()
        .mockResolvedValue({ delivered: true, jobId: 'intake-analysis:21:g1', traceId: 'trace-2' }),
    };
    transactionRunner = {
      run: jest.fn(async (callback) => await callback(transactionContext)),
    };
    usecase = new RetryIntakeAnalysisUsecase(
      repairRequestService as unknown as RepairRequestService,
      intakeAnalysisService as unknown as IntakeAnalysisService,
      asyncTaskRecordService as unknown as AsyncTaskRecordService,
      asyncTaskRecordQueryService as unknown as AsyncTaskRecordQueryService,
      deliverUsecase as unknown as DeliverIntakeAnalysisUsecase,
      transactionRunner,
    );
  });

  it('第 0 代失败后本人重试：原子切到第 1 代、登记 g1 账本行、事务后投递', async () => {
    const result = await usecase.execute(buildCommand());

    expect(result).toEqual({
      requestId: 11,
      intakeId: 21,
      analysisGeneration: 1,
      analysisStatus: 'WAITING',
      delivered: true,
    });
    expect(intakeAnalysisService.loadRetryFacts).toHaveBeenCalledWith({
      intakeId: 21,
      transactionContext,
    });
    expect(intakeAnalysisService.bumpAnalysisGenerationForRetry).toHaveBeenCalledWith({
      intakeId: 21,
      transactionContext,
    });
    // 账本核对按当前代次的确定性 jobId 读取
    expect(asyncTaskRecordQueryService.findByQueueJob).toHaveBeenCalledWith({
      where: { queueName: 'intake-analysis', jobId: 'intake-analysis:21:g0' },
    });
    const ledgerInput = asyncTaskRecordService.recordEnqueued.mock.calls[0][0];
    expect(ledgerInput.data).toMatchObject({
      queueName: 'intake-analysis',
      jobName: 'analyze',
      jobId: 'intake-analysis:21:g1',
      bizType: 'intake_analysis',
      source: 'user_action',
      reason: 'enqueue_accepted:intake_retry',
    });
    expect(ledgerInput.transactionContext).toBe(transactionContext);
    expect(deliverUsecase.execute).toHaveBeenCalledWith({
      intakeId: 21,
      generationNo: 1,
      traceId: expect.any(String),
    });
  });

  it('非本人统一 NOT_FOUND，不泄露他人申请存在性', async () => {
    repairRequestService.findSnapshotById.mockResolvedValueOnce({
      id: 11,
      customerAccountId: 8,
      deprecated: false,
      intakeId: 21,
    });

    await expectRejectedWithoutSideEffects(REPAIR_REQUEST_ERROR.NOT_FOUND);
  });

  it('已删除报修不可重试', async () => {
    repairRequestService.findSnapshotById.mockResolvedValueOnce({
      id: 11,
      customerAccountId: 7,
      deprecated: true,
      intakeId: 21,
    });

    await expectRejectedWithoutSideEffects(REPAIR_REQUEST_ERROR.NOT_FOUND);
  });

  it('原稿行缺失或已删除：按 NOT_FOUND 失败关闭（不泄露数据异常）', async () => {
    intakeAnalysisService.loadRetryFacts.mockResolvedValueOnce(null);
    await expectRejectedWithoutSideEffects(REPAIR_REQUEST_ERROR.NOT_FOUND);

    intakeAnalysisService.loadRetryFacts.mockResolvedValueOnce({
      ...eligibleRetryFacts,
      intakeDeleted: true,
    });
    await expectRejectedWithoutSideEffects(REPAIR_REQUEST_ERROR.NOT_FOUND);
  });

  it('原稿归属与工单不一致（归属冲突）：按 NOT_FOUND 拒绝', async () => {
    intakeAnalysisService.loadRetryFacts.mockResolvedValueOnce({
      ...eligibleRetryFacts,
      intakeCustomerAccountId: 8,
    });

    await expectRejectedWithoutSideEffects(REPAIR_REQUEST_ERROR.NOT_FOUND);
  });

  it('并发/重复重试（原子条件更新未命中）按 CONFLICT 拒绝，不重复登记账本', async () => {
    // 事实读取后另一个请求先完成代次切换：条件更新 affected=0，本次不得再登记/投递
    intakeAnalysisService.bumpAnalysisGenerationForRetry.mockResolvedValueOnce({ affected: 0 });

    await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.ANALYSIS_RETRY_UNAVAILABLE,
    });
    expect(intakeAnalysisService.bumpAnalysisGenerationForRetry).toHaveBeenCalledTimes(1);
    expect(asyncTaskRecordService.recordEnqueued).not.toHaveBeenCalled();
    expect(deliverUsecase.execute).not.toHaveBeenCalled();
  });

  it('排队中 / 运行中：后台仍会补投，不开放客户恢复', async () => {
    for (const status of ['WAITING', 'RUNNING']) {
      intakeAnalysisService.loadRetryFacts.mockResolvedValueOnce({
        ...eligibleRetryFacts,
        status,
      });
      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.ANALYSIS_RETRY_UNAVAILABLE,
      });
    }
    expect(intakeAnalysisService.bumpAnalysisGenerationForRetry).not.toHaveBeenCalled();
    expect(asyncTaskRecordService.recordEnqueued).not.toHaveBeenCalled();
  });

  it('第 1 代再次失败：唯一重试机会已用掉，按 CONFLICT 拒绝', async () => {
    intakeAnalysisService.loadRetryFacts.mockResolvedValueOnce({
      ...eligibleRetryFacts,
      generation: 1,
      attemptGenerationNo: 1,
    });

    await expectRejectedWithoutSideEffects(REPAIR_REQUEST_ERROR.ANALYSIS_RETRY_UNAVAILABLE);
  });

  it('最新实际结果不是受控失败（尝试行缺失/状态矛盾/无失败原因）：不可重试', async () => {
    const cases = [
      { attemptGenerationNo: null, attemptStatus: null, attemptFailureReasonRecorded: false },
      { attemptGenerationNo: 0, attemptStatus: 'SUCCEEDED', attemptFailureReasonRecorded: false },
      { attemptGenerationNo: 0, attemptStatus: 'RUNNING', attemptFailureReasonRecorded: false },
      { attemptGenerationNo: 0, attemptStatus: 'FAILED', attemptFailureReasonRecorded: false },
    ];
    for (const overrides of cases) {
      intakeAnalysisService.loadRetryFacts.mockResolvedValueOnce({
        ...eligibleRetryFacts,
        ...overrides,
      });
      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.ANALYSIS_RETRY_UNAVAILABLE,
      });
    }
    expect(asyncTaskRecordService.recordEnqueued).not.toHaveBeenCalled();
  });

  it('缺少当前代次的投递意图账本行：记录不可信，不开放自助重试', async () => {
    asyncTaskRecordQueryService.findByQueueJob.mockResolvedValueOnce(null);

    await expectRejectedWithoutSideEffects(REPAIR_REQUEST_ERROR.ANALYSIS_RETRY_UNAVAILABLE);
  });

  it('账本不可读（能力停用等）：失败关闭且不泄露内部异常', async () => {
    asyncTaskRecordQueryService.findByQueueJob.mockRejectedValueOnce(
      new Error(
        'capability intake.analysis disabled: queue intake-analysis job intake-analysis:21:g0',
      ),
    );

    let caught: unknown;
    try {
      await usecase.execute(buildCommand());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe(REPAIR_REQUEST_ERROR.ANALYSIS_RETRY_UNAVAILABLE);
    // 不泄露内部异常、队列名或任务标识
    const serialized = JSON.stringify((caught as DomainError).details ?? {});
    expect(serialized).not.toContain('intake-analysis:21');
    expect(serialized).not.toContain('capability');
    expect(String((caught as DomainError).message)).not.toContain('intake-analysis');
    expect(asyncTaskRecordService.recordEnqueued).not.toHaveBeenCalled();
  });

  it('旧工单无原稿（intakeId=null）：无重试语义，按 CONFLICT 拒绝', async () => {
    repairRequestService.findSnapshotById.mockResolvedValueOnce({
      id: 11,
      customerAccountId: 7,
      deprecated: false,
      intakeId: null,
    });

    await expectRejectedWithoutSideEffects(REPAIR_REQUEST_ERROR.ANALYSIS_RETRY_UNAVAILABLE);
  });

  it('仅 CUSTOMER 可重试，SUPER_ADMIN 不放行', async () => {
    await expect(
      usecase.execute(buildCommand({ session: { accountId: 7, roles: ['SUPER_ADMIN'] } })),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });

  it('requestId 非正整数拒绝且不开事务', async () => {
    await expect(usecase.execute(buildCommand({ requestId: 0 }))).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.INVALID_PARAMS,
    });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });

  it('入队失败不改变重试成功语义（delivered=false 由 housekeeping 补投）', async () => {
    deliverUsecase.execute.mockResolvedValueOnce({
      delivered: false,
      jobId: 'intake-analysis:21:g1',
      traceId: 'trace-2',
    });

    const result = await usecase.execute(buildCommand());

    expect(result.analysisGeneration).toBe(1);
    expect(result.delivered).toBe(false);
  });

  it('域错误保持 DomainError 形状（可断言 details）', async () => {
    intakeAnalysisService.bumpAnalysisGenerationForRetry.mockResolvedValueOnce({ affected: 0 });

    let caught: unknown;
    try {
      await usecase.execute(buildCommand());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe(REPAIR_REQUEST_ERROR.ANALYSIS_RETRY_UNAVAILABLE);
  });
});
