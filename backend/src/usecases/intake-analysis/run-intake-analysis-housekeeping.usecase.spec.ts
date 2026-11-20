// src/usecases/intake-analysis/run-intake-analysis-housekeeping.usecase.spec.ts
// housekeeping 离线测试（替身注入 + 内存账本）：
// - 崩溃恢复补投与状态感知（在途不抢投、终态保留先移除再补投）；
// - 写回已完成但账本未终结的收敛（成功/失败两类真实归终态，不再调用模型）；
// - 永久错误受控终结（不可解析 jobId、尝试行越界）与重复扫描不再入队；
// - 不可执行意图取消（删除、代次切换、未关联工单）与在途保护；
// - 并发收尾（条件更新命中 0 行）与异常隔离。
//
// 扫描边界验证：查询服务按 queueName + 状态过滤 + 已收敛原因排除，
// 不扫 WAITING 原稿，Seed 样例不会进入投递。

import {
  INTAKE_ANALYSIS_PERMANENT_ATTEMPT_INCONSISTENT_REASON,
  INTAKE_ANALYSIS_PERMANENT_UNPARSABLE_JOB_ID_REASON,
  INTAKE_ANALYSIS_RECONCILE_FAILED_REASON,
  INTAKE_ANALYSIS_RECONCILE_SUCCEEDED_REASON,
  INTAKE_ANALYSIS_WORKER_PERMANENT_PREFIX,
} from '@core/common/async-task/intake-analysis-failure.policy';
import type { AsyncTaskRecordView } from '@src/modules/async-task-record/async-task-record.types';
import type { AsyncTaskRecordService } from '@src/modules/async-task-record/async-task-record.service';
import type { AsyncTaskRecordQueryService } from '@src/modules/async-task-record/queries/async-task-record.query.service';
import type {
  IntakeAnalysisDeliveryReadiness,
  IntakeAnalysisService,
} from '@src/modules/lithography/intake-analysis.service';
import type { IntakeAnalysisQueueService } from '@src/modules/lithography/queue/intake-analysis-queue.service';
import type { IntakeAnalysisRedeliverAction } from '@src/modules/lithography/queue/intake-analysis-queue.types';
import { RunIntakeAnalysisHousekeepingUsecase } from './run-intake-analysis-housekeeping.usecase';

type MutableRecord = {
  id: number;
  queueName: string;
  jobId: string;
  traceId: string;
  status: 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  reason: string | null;
  finishedAt: Date | null;
  updatedAt: Date;
};

type ListStaleInput = {
  queueName: string;
  statuses: ReadonlyArray<'queued' | 'processing' | 'failed' | 'succeeded'>;
  staleBefore: Date;
  limit: number;
  excludeReasonPrefixes?: ReadonlyArray<string>;
};

type HistoryEntry = {
  id: number;
  status: MutableRecord['status'];
  reason: string | null;
  finishedAt: Date | null;
};

const buildRow = (overrides: Partial<MutableRecord> = {}): MutableRecord => ({
  id: 1,
  queueName: 'intake-analysis',
  jobId: 'intake-analysis:21:g0',
  traceId: 'trace-1',
  status: 'queued',
  reason: 'enqueue_accepted',
  finishedAt: null,
  updatedAt: new Date('2026-11-20T09:00:00.000Z'),
  ...overrides,
});

const toView = (row: MutableRecord): AsyncTaskRecordView =>
  ({
    ...row,
    jobName: 'analyze',
    actorAccountId: 7,
    actorActiveRole: 'CUSTOMER',
    bizType: 'intake_analysis',
    bizKey: row.traceId,
    bizSubKey: null,
    source: 'user_action',
    occurredAt: row.updatedAt,
    dedupKey: null,
    attemptCount: 1,
    maxAttempts: 3,
    enqueuedAt: row.updatedAt,
    startedAt: null,
    createdAt: row.updatedAt,
  }) satisfies AsyncTaskRecordView;

describe('RunIntakeAnalysisHousekeepingUsecase', () => {
  const now = new Date('2026-11-20T10:00:00.000Z');

  let ledger: MutableRecord[];
  let readiness: Map<string, IntakeAnalysisDeliveryReadiness>;
  let jobStates: Map<string, 'waiting' | 'active' | 'delayed' | 'completed' | 'failed' | 'unknown'>;
  let redeliverCalls: Array<{ intakeId: number; generationNo: number; traceId: string }>;
  let settleCalls: HistoryEntry[];

  let asyncTaskRecordService: {
    settleByQueueJob: jest.Mock;
  };
  let queryService: {
    listStaleActiveByQueue: jest.Mock<Promise<AsyncTaskRecordView[]>, [ListStaleInput]>;
  };
  let queueService: {
    redeliverIntakeAnalysis: jest.Mock;
    getIntakeAnalysisJobState: jest.Mock;
  };
  let intakeAnalysisService: { resolveIntakeDeliveryReadiness: jest.Mock };
  let usecase: RunIntakeAnalysisHousekeepingUsecase;

  beforeEach(() => {
    ledger = [];
    readiness = new Map();
    jobStates = new Map();
    redeliverCalls = [];
    settleCalls = [];

    asyncTaskRecordService = {
      settleByQueueJob: jest.fn(
        (input: {
          queueName: string;
          jobId: string;
          fromStatuses: ReadonlyArray<MutableRecord['status']>;
          status: MutableRecord['status'];
          reason?: string | null;
          finishedAt?: Date;
        }): Promise<number> => {
          const row = ledger.find(
            (candidate) =>
              candidate.queueName === input.queueName && candidate.jobId === input.jobId,
          );
          if (!row || !input.fromStatuses.includes(row.status)) {
            // 条件更新未命中：模拟并发收尾/状态已变化
            return Promise.resolve(0);
          }
          row.status = input.status;
          if (input.reason !== undefined) {
            row.reason = input.reason;
          }
          if (input.finishedAt !== undefined) {
            row.finishedAt = input.finishedAt;
          }
          row.updatedAt = now;
          settleCalls.push({
            id: row.id,
            status: row.status,
            reason: row.reason,
            finishedAt: row.finishedAt,
          });
          return Promise.resolve(1);
        },
      ),
    };

    queryService = {
      listStaleActiveByQueue: jest.fn((input: ListStaleInput) => {
        const excluded = input.excludeReasonPrefixes ?? [];
        return Promise.resolve(
          ledger
            .filter((row) => row.queueName === input.queueName)
            .filter((row) => (input.statuses as ReadonlyArray<string>).includes(row.status))
            .filter((row) => row.updatedAt.getTime() <= input.staleBefore.getTime())
            .filter((row) => !excluded.some((prefix) => (row.reason ?? '').startsWith(prefix)))
            .slice(0, input.limit)
            .map(toView),
        );
      }),
    };

    queueService = {
      redeliverIntakeAnalysis: jest.fn(
        (input: {
          intakeId: number;
          generationNo: number;
          traceId: string;
        }): Promise<IntakeAnalysisRedeliverAction> => {
          redeliverCalls.push(input);
          return Promise.resolve({ kind: 'redelivered', basis: 'job_missing' });
        },
      ),
      getIntakeAnalysisJobState: jest.fn((input: { intakeId: number; generationNo: number }) =>
        Promise.resolve(
          jobStates.get(`intake-analysis:${input.intakeId}:g${input.generationNo}`) ?? 'unknown',
        ),
      ),
    };

    intakeAnalysisService = {
      resolveIntakeDeliveryReadiness: jest.fn(
        (input: { intakeId: number; generationNo: number }) => {
          const key = `intake-analysis:${input.intakeId}:g${input.generationNo}`;
          const value = readiness.get(key);
          if (!value) {
            throw new Error(`unexpected readiness lookup: ${key}`);
          }
          return Promise.resolve(value);
        },
      ),
    };

    usecase = new RunIntakeAnalysisHousekeepingUsecase(
      asyncTaskRecordService as unknown as AsyncTaskRecordService,
      queryService as unknown as AsyncTaskRecordQueryService,
      queueService as unknown as IntakeAnalysisQueueService,
      intakeAnalysisService as unknown as IntakeAnalysisService,
    );
  });

  describe('扫描边界', () => {
    it('查询只扫首析自己的队列、非终态状态与已收敛原因，零账本即零投递', async () => {
      const result = await usecase.execute({ now, batchLimit: 10 });

      expect(result).toMatchObject({
        redeliverStaleQueued: { scanned: 0, redelivered: 0, reconciled: 0, parked: 0 },
        recoverStaleProcessing: { scanned: 0, redelivered: 0 },
        cancelOrphanedIntents: { scanned: 0, cancelled: 0 },
      });
      expect(redeliverCalls).toEqual([]);
      expect(settleCalls).toEqual([]);
      expect(queueService.getIntakeAnalysisJobState).not.toHaveBeenCalled();
      expect(intakeAnalysisService.resolveIntakeDeliveryReadiness).not.toHaveBeenCalled();

      for (const [input] of queryService.listStaleActiveByQueue.mock.calls) {
        expect(input.queueName).toBe('intake-analysis');
        expect(input.limit).toBe(10);
        expect(input.excludeReasonPrefixes).toEqual(
          expect.arrayContaining([INTAKE_ANALYSIS_WORKER_PERMANENT_PREFIX]),
        );
        expect(input.statuses).not.toContain('succeeded');
        expect(input.statuses).not.toContain('cancelled');
      }
      // 扫描锚点是首析账本行，不存在的 WAITING 原稿不会被列出
      const scannedStatuses = queryService.listStaleActiveByQueue.mock.calls.flatMap(
        ([input]) => input.statuses,
      );
      expect(scannedStatuses).toContain('queued');
      expect(scannedStatuses).toContain('processing');
      expect(scannedStatuses).toContain('failed');
    });

    it('无首析账本的 WAITING 原稿（Seed）：零补投、零入队', async () => {
      ledger = [];

      const result = await usecase.execute({ now });

      expect(result.redeliverStaleQueued.redelivered).toBe(0);
      expect(result.recoverStaleProcessing.redelivered).toBe(0);
      expect(redeliverCalls).toEqual([]);
    });
  });

  describe('崩溃恢复补投', () => {
    it('job 不存在（job_missing）→ 按原 traceId 补投并回到 queued 意图态', async () => {
      ledger = [buildRow()];
      readiness.set('intake-analysis:21:g0', 'claimable');

      const result = await usecase.execute({ now });

      expect(result.redeliverStaleQueued).toMatchObject({ scanned: 1, redelivered: 1 });
      expect(redeliverCalls).toEqual([{ intakeId: 21, generationNo: 0, traceId: 'trace-1' }]);
      expect(ledger[0]).toMatchObject({
        status: 'queued',
        reason: 'intake_housekeeping_redeliver',
      });
    });

    it('job 在途（in_flight）→ 不抢投、不改写账本', async () => {
      ledger = [buildRow()];
      readiness.set('intake-analysis:21:g0', 'claimable');
      queueService.redeliverIntakeAnalysis.mockResolvedValueOnce({ kind: 'in_flight' });

      const result = await usecase.execute({ now });

      expect(result.redeliverStaleQueued).toMatchObject({ scanned: 1, redelivered: 0, skipped: 1 });
      expect(settleCalls).toEqual([]);
    });

    it('job 终态保留（job_terminal_removed）→ 移除后补投，构成真实恢复', async () => {
      ledger = [buildRow()];
      readiness.set('intake-analysis:21:g0', 'claimable');
      queueService.redeliverIntakeAnalysis.mockResolvedValueOnce({
        kind: 'redelivered',
        basis: 'job_terminal_removed',
      });

      const result = await usecase.execute({ now });

      expect(result.redeliverStaleQueued).toMatchObject({ scanned: 1, redelivered: 1 });
    });

    it('租约仍在有效期内（lease_in_flight）→ 不补投、不重置账本', async () => {
      ledger = [buildRow({ status: 'processing' })];
      readiness.set('intake-analysis:21:g0', 'lease_in_flight');

      const result = await usecase.execute({ now });

      expect(result.recoverStaleProcessing).toMatchObject({
        scanned: 1,
        redelivered: 0,
        skipped: 1,
      });
      expect(redeliverCalls).toEqual([]);
      expect(settleCalls).toEqual([]);
    });

    it('补投链路抛错 → 计入 failed，账本保持原状且不中断其他行', async () => {
      ledger = [
        buildRow(),
        buildRow({ id: 2, jobId: 'intake-analysis:22:g0', traceId: 'trace-2' }),
      ];
      readiness.set('intake-analysis:21:g0', 'claimable');
      readiness.set('intake-analysis:22:g0', 'claimable');
      queueService.redeliverIntakeAnalysis
        .mockRejectedValueOnce(new Error('redis down'))
        .mockResolvedValueOnce({ kind: 'redelivered', basis: 'job_missing' });

      const result = await usecase.execute({ now });

      expect(result.redeliverStaleQueued).toMatchObject({ scanned: 2, redelivered: 1, failed: 1 });
      expect(ledger[0]).toMatchObject({ status: 'queued', reason: 'enqueue_accepted' });
    });
  });

  describe('写回已完成但账本未终结（收敛，不重新调用模型）', () => {
    it('processing + 业务成功 → 账本收敛为 succeeded，且不产生任何补投', async () => {
      ledger = [buildRow({ status: 'processing', reason: 'worker_processing' })];
      readiness.set('intake-analysis:21:g0', 'intent_succeeded');

      const result = await usecase.execute({ now });

      expect(result.recoverStaleProcessing).toMatchObject({ scanned: 1, reconciled: 1 });
      expect(result.recoverStaleProcessing.redelivered).toBe(0);
      expect(redeliverCalls).toEqual([]);
      expect(ledger[0]).toMatchObject({
        status: 'succeeded',
        reason: INTAKE_ANALYSIS_RECONCILE_SUCCEEDED_REASON,
      });
      expect(ledger[0].finishedAt).toEqual(now);
    });

    it('processing + 业务失败 → 账本收敛为 failed，不伪装成成功', async () => {
      ledger = [buildRow({ status: 'processing', reason: 'worker_processing' })];
      readiness.set('intake-analysis:21:g0', 'intent_failed');

      const result = await usecase.execute({ now });

      expect(result.recoverStaleProcessing).toMatchObject({ scanned: 1, reconciled: 1 });
      expect(redeliverCalls).toEqual([]);
      expect(ledger[0]).toMatchObject({
        status: 'failed',
        reason: INTAKE_ANALYSIS_RECONCILE_FAILED_REASON,
      });
      expect(ledger[0].status).not.toBe('succeeded');
      expect(ledger[0].reason).not.toContain('worker_completed');
    });

    it('queued + 业务成功（complete 前失败）→ 收敛为 succeeded，不重复投递', async () => {
      ledger = [buildRow({ status: 'queued' })];
      readiness.set('intake-analysis:21:g0', 'intent_succeeded');

      const result = await usecase.execute({ now });

      expect(result.redeliverStaleQueued).toMatchObject({ scanned: 1, reconciled: 1 });
      expect(redeliverCalls).toEqual([]);
      expect(ledger[0].status).toBe('succeeded');
    });

    it('failed + 业务失败 → 账本终态与真实结果一致并离开补投扫描', async () => {
      ledger = [buildRow({ status: 'failed', reason: 'worker_failed:db_down' })];
      readiness.set('intake-analysis:21:g0', 'intent_failed');

      const first = await usecase.execute({ now });
      expect(first.redeliverStaleQueued).toMatchObject({ scanned: 1, reconciled: 1 });
      expect(ledger[0]).toMatchObject({
        status: 'failed',
        reason: INTAKE_ANALYSIS_RECONCILE_FAILED_REASON,
      });

      const second = await usecase.execute({ now });
      expect(second.redeliverStaleQueued.scanned).toBe(0);
      expect(second.cancelOrphanedIntents.scanned).toBe(0);
    });

    it('重复执行幂等：已收敛的账本下一轮既不改写也不入队', async () => {
      ledger = [buildRow({ status: 'processing', reason: 'worker_processing' })];
      readiness.set('intake-analysis:21:g0', 'intent_succeeded');

      await usecase.execute({ now });
      const writesAfterFirstTick = settleCalls.length;
      const second = await usecase.execute({ now });

      expect(writesAfterFirstTick).toBe(1);
      expect(settleCalls).toHaveLength(1);
      expect(second.recoverStaleProcessing.scanned).toBe(0);
      expect(redeliverCalls).toEqual([]);
    });

    it('并发收尾：条件更新命中 0 行 → 计入 skipped，不报错也不二次改写', async () => {
      ledger = [buildRow({ status: 'processing', reason: 'worker_processing' })];
      readiness.set('intake-analysis:21:g0', 'intent_succeeded');
      asyncTaskRecordService.settleByQueueJob.mockResolvedValueOnce(0);

      const result = await usecase.execute({ now });

      expect(result.recoverStaleProcessing).toMatchObject({
        scanned: 1,
        reconciled: 0,
        skipped: 1,
        failed: 0,
      });
      expect(ledger[0].status).toBe('processing');
    });

    it('收敛写入抛错：计入 failed，账本与业务状态均不改写（下一轮可重试）', async () => {
      ledger = [buildRow({ status: 'processing', reason: 'worker_processing' })];
      readiness.set('intake-analysis:21:g0', 'intent_succeeded');
      asyncTaskRecordService.settleByQueueJob.mockRejectedValueOnce(new Error('db down'));

      const result = await usecase.execute({ now });

      expect(result.recoverStaleProcessing).toMatchObject({ failed: 1, reconciled: 0 });
      expect(ledger[0]).toMatchObject({ status: 'processing', reason: 'worker_processing' });
      expect(redeliverCalls).toEqual([]);
    });

    it('旧代次账本不被新代次结果改写：只按本行代次判定并取消', async () => {
      ledger = [buildRow({ id: 1, jobId: 'intake-analysis:21:g0' })];
      readiness.set('intake-analysis:21:g0', 'generation_mismatch');

      const result = await usecase.execute({ now });

      expect(result.cancelOrphanedIntents).toMatchObject({ cancelled: 1 });
      expect(settleCalls).toEqual([
        expect.objectContaining({
          id: 1,
          status: 'cancelled',
          reason: 'intake_cancelled_stale_intent',
        }),
      ]);
      expect(redeliverCalls).toEqual([]);
    });
  });

  describe('永久错误受控终结（不无限补投，不消耗主动重试）', () => {
    it('jobId 不可解析 → 受控终结为 failed + permanent，绝不入队', async () => {
      ledger = [buildRow({ jobId: 'not-an-intake-job' })];

      const result = await usecase.execute({ now });

      expect(result.redeliverStaleQueued).toMatchObject({ scanned: 1, parked: 1, redelivered: 0 });
      expect(ledger[0]).toMatchObject({
        status: 'failed',
        reason: INTAKE_ANALYSIS_PERMANENT_UNPARSABLE_JOB_ID_REASON,
      });
      expect(redeliverCalls).toEqual([]);
      expect(intakeAnalysisService.resolveIntakeDeliveryReadiness).not.toHaveBeenCalled();
    });

    it('尝试行状态越过状态机（attempt_inconsistent）→ 人工处置终态，不补投', async () => {
      ledger = [buildRow({ status: 'processing', reason: 'worker_processing' })];
      readiness.set('intake-analysis:21:g0', 'attempt_inconsistent');

      const first = await usecase.execute({ now });

      expect(first.recoverStaleProcessing).toMatchObject({ scanned: 1, parked: 1 });
      expect(ledger[0]).toMatchObject({
        status: 'failed',
        reason: INTAKE_ANALYSIS_PERMANENT_ATTEMPT_INCONSISTENT_REASON,
      });
      expect(redeliverCalls).toEqual([]);
    });

    it('已受控终结的账本行重复扫描：查询即排除，零扫描零入队', async () => {
      ledger = [
        buildRow({
          status: 'failed',
          reason: `${INTAKE_ANALYSIS_WORKER_PERMANENT_PREFIX}intake_job_id_unparsable`,
        }),
      ];
      readiness.set('intake-analysis:21:g0', 'claimable');

      const result = await usecase.execute({ now });

      expect(result.redeliverStaleQueued.scanned).toBe(0);
      expect(result.cancelOrphanedIntents.scanned).toBe(0);
      expect(redeliverCalls).toEqual([]);
      expect(settleCalls).toEqual([]);
    });

    it('同一临时失败的 failed 行连续两轮只补投一次（补投后账本回到 queued 且不在静默窗口外）', async () => {
      ledger = [buildRow({ status: 'failed', reason: 'worker_failed:db_down' })];
      readiness.set('intake-analysis:21:g0', 'claimable');

      const first = await usecase.execute({ now });
      const second = await usecase.execute({ now });

      expect(first.redeliverStaleQueued).toMatchObject({ redelivered: 1 });
      expect(second.redeliverStaleQueued).toMatchObject({ redelivered: 0 });
      expect(redeliverCalls).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        status: 'queued',
        reason: 'intake_housekeeping_redeliver',
      });
    });

    it('临时故障保持可补投：不能被错误终结为永久失败', async () => {
      ledger = [buildRow({ status: 'failed', reason: 'worker_failed:redis_down' })];
      readiness.set('intake-analysis:21:g0', 'claimable');

      await usecase.execute({ now });

      expect(ledger[0].status).not.toBe('failed');
      expect(ledger[0].reason).not.toContain(INTAKE_ANALYSIS_WORKER_PERMANENT_PREFIX);
      expect(redeliverCalls).toHaveLength(1);
    });
  });

  describe('不可执行意图取消', () => {
    it('原稿已删除且 job 不在途 → 取消账本行，不补投', async () => {
      ledger = [buildRow()];
      readiness.set('intake-analysis:21:g0', 'deleted_or_missing');
      jobStates.set('intake-analysis:21:g0', 'unknown');

      const result = await usecase.execute({ now });

      expect(result.cancelOrphanedIntents).toMatchObject({ scanned: 1, cancelled: 1 });
      expect(ledger[0]).toMatchObject({
        status: 'cancelled',
        reason: 'intake_cancelled_target_deleted',
      });
      expect(redeliverCalls).toEqual([]);
    });

    it('原稿已删除但 job 仍在途 → 本轮跳过，等认领侧拒绝后下一轮再取消', async () => {
      ledger = [buildRow()];
      readiness.set('intake-analysis:21:g0', 'deleted_or_missing');
      jobStates.set('intake-analysis:21:g0', 'active');

      const result = await usecase.execute({ now });

      expect(result.cancelOrphanedIntents).toMatchObject({ scanned: 1, cancelled: 0, skipped: 1 });
      expect(ledger[0].status).toBe('queued');
    });

    it('未关联工单（not_converted）→ 取消，不再每轮被补投', async () => {
      ledger = [buildRow()];
      readiness.set('intake-analysis:21:g0', 'not_converted');

      const first = await usecase.execute({ now });
      const second = await usecase.execute({ now });

      expect(first.cancelOrphanedIntents).toMatchObject({ cancelled: 1 });
      expect(redeliverCalls).toEqual([]);
      expect(second.cancelOrphanedIntents.scanned).toBe(0);
    });

    it('processing 状态下的不可执行意图也会被取消（不留滞留行）', async () => {
      ledger = [buildRow({ status: 'processing', reason: 'worker_processing' })];
      readiness.set('intake-analysis:21:g0', 'deleted_or_missing');

      const result = await usecase.execute({ now });

      expect(result.cancelOrphanedIntents).toMatchObject({ cancelled: 1 });
      expect(ledger[0].status).toBe('cancelled');
      expect(redeliverCalls).toEqual([]);
    });

    it('业务已失败 + queued → 按 stale 意图取消（不重复投递已失败的代次）', async () => {
      ledger = [buildRow()];
      readiness.set('intake-analysis:21:g0', 'intent_failed');

      const result = await usecase.execute({ now });

      expect(result.redeliverStaleQueued).toMatchObject({ redelivered: 0, skipped: 1 });
      expect(result.cancelOrphanedIntents).toMatchObject({ cancelled: 1 });
      expect(ledger[0]).toMatchObject({
        status: 'cancelled',
        reason: 'intake_cancelled_stale_intent',
      });
      expect(redeliverCalls).toEqual([]);
    });

    it('账本指向另一原稿时只改自己那一行（异主账本不被改写）', async () => {
      ledger = [
        buildRow({ id: 1, jobId: 'intake-analysis:21:g0', traceId: 'trace-1' }),
        buildRow({ id: 2, jobId: 'intake-analysis:22:g0', traceId: 'trace-2' }),
      ];
      readiness.set('intake-analysis:21:g0', 'deleted_or_missing');
      readiness.set('intake-analysis:22:g0', 'claimable');

      await usecase.execute({ now });

      expect(ledger[0]).toMatchObject({ status: 'cancelled' });
      expect(ledger[1]).toMatchObject({
        status: 'queued',
        reason: 'intake_housekeeping_redeliver',
      });
      expect(settleCalls.map((entry) => entry.id).sort()).toEqual([1, 2]);
    });
  });
});
