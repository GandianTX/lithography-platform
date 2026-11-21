// src/usecases/intake-analysis/run-intake-analysis-housekeeping.usecase.ts
// 首析投递 housekeeping（任务 03 第二段）：凭首析自己的持久任务标识做崩溃恢复。
//
// 扫描边界：只扫 `base_async_task_record` 中 queueName = 'intake-analysis' 的
// 非终态/失败账本行 —— 不扫 repair_request_intake 的 WAITING 行，开发 Seed 的
// 待分析样例不会进入投递，其他 AI 任务队列也不受影响。
//
// 三个阶段的职责（每行只按「就绪度 + 账本当前状态」得出一个收尾动作）：
// 1. redeliverStaleQueued：queued / failed 且已过静默窗口 → 可执行的补投，
//    已按业务结果终态的行收敛账本，结构不可恢复的行受控终结；
// 2. recoverStaleProcessing：processing 且已过租约宽限 → 写回已完成则按真实结果
//    收敛账本（不再调用模型），租约已过期则补投并由认领侧接管；
// 3. cancelOrphanedIntents：任何状态下的不可执行意图（已删除原稿 / 代次切换 /
//    未关联工单）在 job 不在途时取消账本行。
//
// 补投是状态感知的（BullMQ 5.x 同 jobId 语义）：
// - job 在途（waiting/active/delayed，含重试退避）→ 不抢投；
// - job 终态保留（completed/failed）→ 不会因再次 add 自动进入 waiting，
//   必须先移除再补投才构成真实恢复；补投后的执行安全由认领侧状态机
//   （ALREADY_SUCCEEDED / ALREADY_FAILED / 代次匹配 / 租约接管）兜底，
//   不依赖「补投成功」这一动作本身；
// - job 不存在 → 直接补投（提交后 enqueue 失败 / 进程在 add 前退出的恢复路径）。
//
// 账本收敛（写回已完成、账本未终结的崩溃窗口）：
// - intake / attempt 已是合法终态时，账本按真实结果收敛为 succeeded / failed，
//   或按不可执行原因收敛为 cancelled，绝不把业务失败写成成功；
// - 收敛只更新账本行（条件 UPDATE，来源状态 = 本行实际观察到的状态），
//   不写 intake / attempt，不调用模型，不推进代次，不消耗客户主动重试；
// - 并发收尾（worker complete/fail 与 housekeeping 同抢一行）由条件更新仲裁，
//   后到者命中 0 行即跳过，不会把已落地的终态改写成另一种终态。
//
// 永久错误（见 @core/common/async-task/intake-analysis-failure.policy）：
// - 已受控终结为 `worker_permanent:*` 或已按事实收敛的行不再参与扫描，
//   避免「移除后无限补投」以及永久行占满限量批次导致后续可恢复行饿死；
// - 临时故障（进程退出、job payload 损坏但 jobId 可解析、租约占用）保持在
//   可补投范围，不被错误终结。
//
// 本用例不推进首析代次、不触发用户的主动重试，仅是基建补投与账本收敛。

import { Injectable, Logger } from '@nestjs/common';
import {
  INTAKE_ANALYSIS_RECONCILE_FAILED_REASON,
  INTAKE_ANALYSIS_RECONCILE_SUCCEEDED_REASON,
  INTAKE_ANALYSIS_PERMANENT_ATTEMPT_INCONSISTENT_REASON,
  INTAKE_ANALYSIS_PERMANENT_UNPARSABLE_JOB_ID_REASON,
  INTAKE_ANALYSIS_WORKER_PERMANENT_PREFIX,
  isPermanentIntakeAnalysisFailureReason,
} from '@core/common/async-task/intake-analysis-failure.policy';
import {
  parseIntakeAnalysisJobId,
  INTAKE_ANALYSIS_QUEUE_NAME,
} from '@core/common/async-task/intake-analysis-job-id.policy';
import type {
  AsyncTaskRecordStatus,
  AsyncTaskRecordView,
} from '@src/modules/async-task-record/async-task-record.types';
import { AsyncTaskRecordQueryService } from '@src/modules/async-task-record/queries/async-task-record.query.service';
import { AsyncTaskRecordService } from '@src/modules/async-task-record/async-task-record.service';
import {
  type IntakeAnalysisDeliveryReadiness,
  IntakeAnalysisService,
} from '@src/modules/lithography/intake-analysis.service';
import { IntakeAnalysisQueueService } from '@src/modules/lithography/queue/intake-analysis-queue.service';
import type {
  IntakeAnalysisHousekeepingPhaseResult,
  IntakeAnalysisHousekeepingResult,
} from './intake-analysis-housekeeping.types';

export const INTAKE_ANALYSIS_HOUSEKEEPING_DEFAULT_QUEUED_GRACE_MS = 5 * 60 * 1000;
export const INTAKE_ANALYSIS_HOUSEKEEPING_DEFAULT_PROCESSING_EXTRA_GRACE_MS = 2 * 60 * 1000;
export const INTAKE_ANALYSIS_HOUSEKEEPING_DEFAULT_BATCH_LIMIT = 50;
const HOUSEKEEPING_BATCH_LIMIT_MAX = 500;

const CANCEL_REASON_TARGET_DELETED = 'intake_cancelled_target_deleted';
const CANCEL_REASON_STALE_INTENT = 'intake_cancelled_stale_intent';
const REDELIVER_REASON = 'intake_housekeeping_redeliver';

/** 恢复扫描同时覆盖 failed 行：认领前系统故障留下的终态账本行也需恢复 */
const RECOVERY_SCAN_STATUSES = ['queued', 'failed'] as const;
/** 取消扫描覆盖所有非终态账本行：不可执行意图不因账本停在 processing 而滞留 */
const CANCEL_SCAN_STATUSES = ['queued', 'failed', 'processing'] as const;

/**
 * 已受控终结 / 已按事实收敛的账本行不再扫描：
 * 永久错误需要人工处理，重复扫描既不产生新结果，也会占住限量批次。
 */
const SETTLED_REASON_PREFIXES: ReadonlyArray<string> = [
  INTAKE_ANALYSIS_WORKER_PERMANENT_PREFIX,
  INTAKE_ANALYSIS_RECONCILE_FAILED_REASON,
];

/** 单行收敛动作：由就绪度 + 账本当前状态唯一决定 */
type IntakeAnalysisSettleAction =
  | { readonly kind: 'redeliver' }
  | { readonly kind: 'reconcile_succeeded' }
  | { readonly kind: 'reconcile_failed' }
  | { readonly kind: 'cancel'; readonly reason: string }
  | { readonly kind: 'park'; readonly reason: string }
  | { readonly kind: 'skip' };

type ScanMode = 'recovery' | 'cancel';

type RowOutcome = 'redelivered' | 'reconciled' | 'parked' | 'cancelled' | 'skipped' | 'failed';

@Injectable()
export class RunIntakeAnalysisHousekeepingUsecase {
  private readonly logger = new Logger(RunIntakeAnalysisHousekeepingUsecase.name);

  constructor(
    private readonly asyncTaskRecordService: AsyncTaskRecordService,
    private readonly asyncTaskRecordQueryService: AsyncTaskRecordQueryService,
    private readonly intakeAnalysisQueueService: IntakeAnalysisQueueService,
    private readonly intakeAnalysisService: IntakeAnalysisService,
  ) {}

  async execute(input?: {
    readonly queuedGraceMs?: number;
    readonly processingExtraGraceMs?: number;
    readonly batchLimit?: number;
    readonly now?: Date;
  }): Promise<IntakeAnalysisHousekeepingResult> {
    const now = input?.now ?? new Date();
    const queuedGraceMs =
      input?.queuedGraceMs ?? INTAKE_ANALYSIS_HOUSEKEEPING_DEFAULT_QUEUED_GRACE_MS;
    const processingExtraGraceMs =
      input?.processingExtraGraceMs ??
      INTAKE_ANALYSIS_HOUSEKEEPING_DEFAULT_PROCESSING_EXTRA_GRACE_MS;
    const batchLimit = Math.min(
      input?.batchLimit ?? INTAKE_ANALYSIS_HOUSEKEEPING_DEFAULT_BATCH_LIMIT,
      HOUSEKEEPING_BATCH_LIMIT_MAX,
    );

    const redeliverStaleQueued = await this.runPhase({
      statuses: [...RECOVERY_SCAN_STATUSES],
      staleBefore: new Date(now.getTime() - queuedGraceMs),
      batchLimit,
      mode: 'recovery',
      now,
    });
    const recoverStaleProcessing = await this.runPhase({
      statuses: ['processing'],
      staleBefore: new Date(now.getTime() - processingExtraGraceMs),
      batchLimit,
      mode: 'recovery',
      now,
    });
    const cancelOrphanedIntents = await this.runPhase({
      statuses: [...CANCEL_SCAN_STATUSES],
      // 取消不设静默窗口：不可执行意图越早收敛越好；与在途执行的冲突由 job 状态检查保护
      staleBefore: now,
      batchLimit,
      mode: 'cancel',
      now,
    });

    return { redeliverStaleQueued, recoverStaleProcessing, cancelOrphanedIntents };
  }

  private async runPhase(params: {
    readonly statuses: ReadonlyArray<'queued' | 'processing' | 'failed'>;
    readonly staleBefore: Date;
    readonly batchLimit: number;
    readonly mode: ScanMode;
    readonly now: Date;
  }): Promise<IntakeAnalysisHousekeepingPhaseResult> {
    const records = await this.asyncTaskRecordQueryService.listStaleActiveByQueue({
      queueName: INTAKE_ANALYSIS_QUEUE_NAME,
      statuses: [...params.statuses],
      staleBefore: params.staleBefore,
      limit: params.batchLimit,
      excludeReasonPrefixes: SETTLED_REASON_PREFIXES,
    });

    const counters: Record<RowOutcome, number> = {
      redelivered: 0,
      reconciled: 0,
      parked: 0,
      cancelled: 0,
      skipped: 0,
      failed: 0,
    };
    for (const record of records) {
      const outcome = await this.settleRecord({
        record,
        mode: params.mode,
        now: params.now,
      });
      counters[outcome] += 1;
    }
    return {
      scanned: records.length,
      redelivered: counters.redelivered,
      reconciled: counters.reconciled,
      parked: counters.parked,
      cancelled: counters.cancelled,
      skipped: counters.skipped,
      failed: counters.failed,
    };
  }

  /**
   * 单行收尾：
   * - 恢复阶段执行补投 / 账本收敛 / 受控终结，取消动作留给取消阶段；
   * - 取消阶段只执行取消，并先确认 job 不在途（不让取消与在途执行互相覆盖）。
   */
  private async settleRecord(params: {
    readonly record: AsyncTaskRecordView;
    readonly mode: ScanMode;
    readonly now: Date;
  }): Promise<RowOutcome> {
    try {
      const action = await this.resolveSettleAction(params.record);
      if (action.kind === 'skip') {
        return 'skipped';
      }
      if (params.mode === 'cancel') {
        return action.kind === 'cancel'
          ? await this.cancelRecord({
              record: params.record,
              reason: action.reason,
              now: params.now,
            })
          : 'skipped';
      }
      switch (action.kind) {
        case 'cancel':
          // 取消有独立的在途检查，统一交给取消阶段
          return 'skipped';
        case 'redeliver':
          return await this.redeliverRecord({ record: params.record });
        case 'reconcile_succeeded':
          return await this.settleLedger({
            record: params.record,
            status: 'succeeded',
            reason: INTAKE_ANALYSIS_RECONCILE_SUCCEEDED_REASON,
            now: params.now,
          });
        case 'reconcile_failed':
          return await this.settleLedger({
            record: params.record,
            status: 'failed',
            reason: INTAKE_ANALYSIS_RECONCILE_FAILED_REASON,
            now: params.now,
          });
        case 'park':
          return await this.settleLedger({
            record: params.record,
            status: 'failed',
            reason: action.reason,
            now: params.now,
          });
      }
    } catch (error: unknown) {
      this.logger.warn(
        `intake housekeeping settle failed for ${params.record.jobId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 'failed';
    }
  }

  /**
   * 就绪度 + 账本当前状态 → 唯一收敛动作（恢复与取消阶段共用同一口径）。
   * 不读取队列状态：账本收敛只依赖数据库事实，Redis 不可用时仍可安全收敛。
   */
  private async resolveSettleAction(
    record: AsyncTaskRecordView,
  ): Promise<IntakeAnalysisSettleAction> {
    const parsed = parseIntakeAnalysisJobId(record.jobId);
    if (!parsed) {
      // 账本 jobId 不符合首析策略：无法定位业务目标，补投不可达 → 受控终结
      return { kind: 'park', reason: INTAKE_ANALYSIS_PERMANENT_UNPARSABLE_JOB_ID_REASON };
    }
    const readiness = await this.intakeAnalysisService.resolveIntakeDeliveryReadiness({
      intakeId: parsed.intakeId,
      generationNo: parsed.generationNo,
    });
    return resolveActionForReadiness(readiness, record);
  }

  private async redeliverRecord(params: {
    readonly record: AsyncTaskRecordView;
  }): Promise<RowOutcome> {
    const parsed = parseIntakeAnalysisJobId(params.record.jobId);
    if (!parsed) {
      return 'skipped';
    }
    const action = await this.intakeAnalysisQueueService.redeliverIntakeAnalysis({
      intakeId: parsed.intakeId,
      generationNo: parsed.generationNo,
      traceId: params.record.traceId,
    });
    if (action.kind !== 'redelivered') {
      return 'skipped';
    }
    // 补投成功：账本回到 queued 意图态（同样带来源状态前置条件，不覆盖并发终态）
    await this.asyncTaskRecordService.settleByQueueJob({
      queueName: INTAKE_ANALYSIS_QUEUE_NAME,
      jobId: params.record.jobId,
      fromStatuses: [params.record.status],
      status: 'queued',
      reason: REDELIVER_REASON,
    });
    return 'redelivered';
  }

  private async settleLedger(params: {
    readonly record: AsyncTaskRecordView;
    readonly status: Extract<AsyncTaskRecordStatus, 'succeeded' | 'failed' | 'cancelled'>;
    readonly reason: string;
    readonly now: Date;
  }): Promise<RowOutcome> {
    const affected = await this.asyncTaskRecordService.settleByQueueJob({
      queueName: INTAKE_ANALYSIS_QUEUE_NAME,
      jobId: params.record.jobId,
      fromStatuses: [params.record.status],
      status: params.status,
      reason: params.reason,
      finishedAt: params.now,
    });
    if (affected === 0) {
      // 并发收尾已经落地（worker complete/fail 或另一 housekeeping 实例）
      return 'skipped';
    }
    const outcome: RowOutcome =
      params.status === 'cancelled'
        ? 'cancelled'
        : isPermanentIntakeAnalysisFailureReason(params.reason)
          ? 'parked'
          : 'reconciled';
    this.logger.log(
      `intake ledger settled: jobId=${params.record.jobId} status=${params.status} reason=${params.reason}`,
    );
    return outcome;
  }

  private async cancelRecord(params: {
    readonly record: AsyncTaskRecordView;
    readonly reason: string;
    readonly now: Date;
  }): Promise<RowOutcome> {
    const parsed = parseIntakeAnalysisJobId(params.record.jobId);
    if (!parsed) {
      return 'skipped';
    }
    const state = await this.intakeAnalysisQueueService.getIntakeAnalysisJobState({
      intakeId: parsed.intakeId,
      generationNo: parsed.generationNo,
    });
    if (state === 'waiting' || state === 'active' || state === 'delayed') {
      // job 仍在途：等它被消费并由认领侧拒绝后，下一轮再取消账本行
      return 'skipped';
    }
    return await this.settleLedger({
      record: params.record,
      status: 'cancelled',
      reason: params.reason,
      now: params.now,
    });
  }
}

/** 就绪度 → 收敛动作（纯函数，便于离线覆盖全部分支） */
function resolveActionForReadiness(
  readiness: IntakeAnalysisDeliveryReadiness,
  record: AsyncTaskRecordView,
): IntakeAnalysisSettleAction {
  switch (readiness) {
    case 'deleted_or_missing':
      // 已删除原稿：意图不可执行，且不得让迟到结果复活记录
      return { kind: 'cancel', reason: CANCEL_REASON_TARGET_DELETED };
    case 'generation_mismatch':
    case 'not_converted':
      // 代次已切换 / 未关联工单：stale 意图不可执行
      return { kind: 'cancel', reason: CANCEL_REASON_STALE_INTENT };
    case 'intent_succeeded':
      return record.status === 'succeeded' ? { kind: 'skip' } : { kind: 'reconcile_succeeded' };
    case 'intent_failed':
      return resolveFailedIntentAction(record);
    case 'attempt_inconsistent':
      // RUNNING 而尝试行缺失/已终态：越过状态机，补投必然重复失败 → 人工处置
      return { kind: 'park', reason: INTAKE_ANALYSIS_PERMANENT_ATTEMPT_INCONSISTENT_REASON };
    case 'claimable':
      return { kind: 'redeliver' };
    case 'lease_in_flight':
      // 租约有效期内有执行在跑，不抢投也不改写账本
      return { kind: 'skip' };
  }
}

/** 业务已失败时的账本收尾：终态与真实结果一致，不伪装成功 */
function resolveFailedIntentAction(record: AsyncTaskRecordView): IntakeAnalysisSettleAction {
  if (record.status === 'failed') {
    // 已是失败终态：只把原因收敛为 reconciled，避免永久占用补投批次
    return record.reason === INTAKE_ANALYSIS_RECONCILE_FAILED_REASON
      ? { kind: 'skip' }
      : { kind: 'reconcile_failed' };
  }
  if (record.status === 'processing') {
    // 写回已完成但账本停在 processing：按真实结果收敛为 failed
    return { kind: 'reconcile_failed' };
  }
  // queued：业务结果已失败，投递意图过期
  return { kind: 'cancel', reason: CANCEL_REASON_STALE_INTENT };
}
