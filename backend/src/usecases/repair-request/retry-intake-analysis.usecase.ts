// src/usecases/repair-request/retry-intake-analysis.usecase.ts
// 首析主动重试用例（任务 03 第二/三段）。
//
// 唯一性语义：
// - 仅本人（customerAccountId 来自会话）可重试，他人/已删除按 NOT_FOUND 统一拒绝；
// - 仅「第 0 代已形成明确的模型分析失败」可重试，事务内原子切换代次 0→1（条件更新）：
//   并发重试只有一个事务命中，重复重试/迟到重试按 CONFLICT 拒绝；
// - 重试不创建新工单、不重绑附件、不修改报修原稿；
// - 重试是用户唯一的一次重新分析机会：基建补投（BullMQ attempts 与
//   housekeeping）不消耗、也不触发该机会；再次失败不可进入第 2 代。
//
// 服务端复核（与详情页展示资格同一策略，`@core/repair-request/policy/
// intake-analysis-retry.policy`）：本人、未删除、当前代次、可信账本、
// 最新实际结果与执行归属。
// - 「最新实际结果」= 当前代次尝试行仍是 FAILED 且记录了受控失败原因；
//   不依据账本 failed / worker_permanent: 前缀，也不依据调用方参数；
// - 「可信账本」= 该代次的投递意图账本行存在（缺行则不可信，失败关闭）；
// - 「执行归属」= 代次切换后任何旧执行凭据都不再匹配（认领/写回均核验代次
//   与尝试行），因此迟到响应不能覆盖重试后的状态。
//
// 与删除/接单的并发：代次切换条件包含未删除；已接单不影响首析重试
// （首析状态独立于工单处理状态）。

import { randomUUID } from 'node:crypto';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  buildIntakeAnalysisJobId,
  INTAKE_ANALYSIS_ASYNC_TASK_BIZ_TYPE,
  INTAKE_ANALYSIS_JOB_NAME,
  INTAKE_ANALYSIS_MAX_ATTEMPTS,
  INTAKE_ANALYSIS_QUEUE_NAME,
} from '@core/common/async-task/intake-analysis-job-id.policy';
import {
  DomainError,
  PERMISSION_ERROR,
  REPAIR_REQUEST_ERROR,
} from '@core/common/errors/domain-error';
import {
  INTAKE_ANALYSIS_RETRY_REASON_INTAKE_DELETED,
  INTAKE_ANALYSIS_RETRY_REASON_NO_INTAKE,
  INTAKE_ANALYSIS_RETRY_REASON_OWNERSHIP_CONFLICT,
  resolveIntakeAnalysisRetryDecision,
} from '@core/repair-request/policy/intake-analysis-retry.policy';
import { Inject, Injectable } from '@nestjs/common';
import { AsyncTaskRecordQueryService } from '@src/modules/async-task-record/queries/async-task-record.query.service';
import { AsyncTaskRecordService } from '@src/modules/async-task-record/async-task-record.service';
import { IntakeAnalysisService } from '@src/modules/lithography/intake-analysis.service';
import { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import { DeliverIntakeAnalysisUsecase } from './deliver-intake-analysis.usecase';
import { readIntakeAnalysisLedgerIntentPresent } from './intake-analysis-retry-ledger';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import type {
  RetryIntakeAnalysisCommand,
  RetryIntakeAnalysisResult,
} from './retry-intake-analysis.types';

const RETRY_GENERATION = 1;

@Injectable()
export class RetryIntakeAnalysisUsecase {
  constructor(
    private readonly repairRequestService: RepairRequestService,
    private readonly intakeAnalysisService: IntakeAnalysisService,
    private readonly asyncTaskRecordService: AsyncTaskRecordService,
    private readonly asyncTaskRecordQueryService: AsyncTaskRecordQueryService,
    private readonly deliverIntakeAnalysisUsecase: DeliverIntakeAnalysisUsecase,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: RetryIntakeAnalysisCommand): Promise<RetryIntakeAnalysisResult> {
    this.assertCustomerRole(command.session.roles);

    if (!Number.isInteger(command.requestId) || command.requestId <= 0) {
      throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '维修申请 ID 无效', {
        requestId: command.requestId,
      });
    }

    const retry = await this.transactionRunner.run((transactionContext) =>
      this.doRetry(command, transactionContext),
    );

    // 事务已提交（代次切换 + 账本行）；入队失败由 housekeeping 补投
    const delivery = await this.deliverIntakeAnalysisUsecase.execute({
      intakeId: retry.intakeId,
      generationNo: RETRY_GENERATION,
      traceId: retry.traceId,
    });

    return {
      requestId: command.requestId,
      intakeId: retry.intakeId,
      analysisGeneration: RETRY_GENERATION,
      analysisStatus: 'WAITING',
      delivered: delivery.delivered,
    };
  }

  private async doRetry(
    command: RetryIntakeAnalysisCommand,
    transactionContext: PersistenceTransactionContext,
  ): Promise<{ readonly intakeId: number; readonly traceId: string }> {
    const request = await this.repairRequestService.findSnapshotById(
      command.requestId,
      transactionContext,
    );
    // 不存在 / 非本人 / 已删除统一 NOT_FOUND（防探测，与删除用例同一口径）
    if (!request || request.customerAccountId !== command.session.accountId || request.deprecated) {
      throw new DomainError(REPAIR_REQUEST_ERROR.NOT_FOUND, '维修申请不存在或不可重试', {
        id: command.requestId,
      });
    }
    if (request.intakeId === null) {
      // 旧工单没有原稿与首析执行意图：无重试语义
      throw new DomainError(
        REPAIR_REQUEST_ERROR.ANALYSIS_RETRY_UNAVAILABLE,
        '该维修申请没有可重试的首次分析',
        { id: command.requestId },
      );
    }

    // 事务内加锁读取原稿与当前代次尝试行事实（只读，不推进状态）
    const facts = await this.intakeAnalysisService.loadRetryFacts({
      intakeId: request.intakeId,
      transactionContext,
    });
    // 原稿行缺失或已删除：按不存在处理，不泄露数据异常细节
    if (facts === null || facts.intakeDeleted) {
      throw new DomainError(REPAIR_REQUEST_ERROR.NOT_FOUND, '维修申请不存在或不可重试', {
        id: command.requestId,
      });
    }

    // 跨模块只读核对：该代次的投递意图账本行是否存在（缺行/不可读 → 不可信）
    const ledgerIntentPresent = await readIntakeAnalysisLedgerIntentPresent(
      this.asyncTaskRecordQueryService,
      { intakeId: request.intakeId, generationNo: facts.generation },
    );

    const decision = resolveIntakeAnalysisRetryDecision({
      requestId: command.requestId,
      viewerCustomerAccountId: command.session.accountId,
      requestCustomerAccountId: request.customerAccountId,
      intakeExists: true,
      intakeCustomerAccountId: facts.intakeCustomerAccountId,
      intakeDeleted: facts.intakeDeleted,
      convertedRequestId: facts.convertedRequestId,
      generation: facts.generation,
      status: facts.status,
      attemptGenerationNo: facts.attemptGenerationNo,
      attemptStatus: facts.attemptStatus,
      attemptFailureReasonRecorded: facts.attemptFailureReasonRecorded,
      ledgerIntentPresent,
    });

    if (!decision.eligible) {
      // 归属冲突与已删除沿用防探测口径；其余为业务状态冲突（前端据此隐藏入口）
      if (this.isNotFoundReason(decision.reason)) {
        throw new DomainError(REPAIR_REQUEST_ERROR.NOT_FOUND, '维修申请不存在或不可重试', {
          id: command.requestId,
        });
      }
      throw new DomainError(
        REPAIR_REQUEST_ERROR.ANALYSIS_RETRY_UNAVAILABLE,
        '首次分析当前状态不支持重新分析',
        { id: command.requestId, intakeId: request.intakeId },
      );
    }

    // 原子代次切换：仅「第 0 代已失败且未删除」命中；并发/重复重试未命中按冲突拒绝
    const bump = await this.intakeAnalysisService.bumpAnalysisGenerationForRetry({
      intakeId: request.intakeId,
      transactionContext,
    });
    if (bump.affected !== 1) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.ANALYSIS_RETRY_UNAVAILABLE,
        '首次分析当前状态不支持重新分析',
        { id: command.requestId, intakeId: request.intakeId },
      );
    }

    const traceId = randomUUID();
    await this.asyncTaskRecordService.recordEnqueued({
      data: {
        queueName: INTAKE_ANALYSIS_QUEUE_NAME,
        jobName: INTAKE_ANALYSIS_JOB_NAME,
        jobId: buildIntakeAnalysisJobId({
          intakeId: request.intakeId,
          generationNo: RETRY_GENERATION,
        }),
        traceId,
        actorAccountId: command.session.accountId,
        actorActiveRole: command.session.activeRole ?? undefined,
        bizType: INTAKE_ANALYSIS_ASYNC_TASK_BIZ_TYPE,
        bizKey: traceId,
        source: 'user_action',
        reason: 'enqueue_accepted:intake_retry',
        maxAttempts: INTAKE_ANALYSIS_MAX_ATTEMPTS,
      },
      transactionContext,
    });

    return { intakeId: request.intakeId, traceId };
  }

  /** 不存在/删除/归属冲突走 NOT_FOUND（防探测）；其余按业务状态冲突拒绝 */
  private isNotFoundReason(reason: string): boolean {
    return (
      reason === INTAKE_ANALYSIS_RETRY_REASON_NO_INTAKE ||
      reason === INTAKE_ANALYSIS_RETRY_REASON_INTAKE_DELETED ||
      reason === INTAKE_ANALYSIS_RETRY_REASON_OWNERSHIP_CONFLICT
    );
  }

  private assertCustomerRole(roles: readonly string[]): void {
    const requiredRole = String(IdentityTypeEnum.CUSTOMER);
    if (!roles.includes(requiredRole)) {
      throw new DomainError(
        PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
        '仅客户账号可以重新分析维修申请',
        { roles: [...roles] },
      );
    }
  }
}
