// src/usecases/repair-request/interrupt-repair-request.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import { DomainError, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import { isRepairRequestEnded } from '@core/repair-request/policy/repair-process-write.policy';
import { isTerminalHandlingStatus } from '@core/repair-request/policy/repair-request-handling.policy';
import { normalizeClosureReason } from '@core/repair-request/policy/repair-request-write-normalize.policy';
import { Inject, Injectable } from '@nestjs/common';
import type { RepairProcessBindingTargetSnapshot } from '@src/modules/lithography/lithography.types';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { assertRepairRequestId } from './assert-repair-request-id';
import { assertEngineerWritePermission } from './engineer-write-permission';

export type InterruptRepairRequestCommand = {
  session: UsecaseSession;
  requestId: number;
  /** 中断原因必填 */
  reason: string;
};

export type RepairRequestInterruptionView = {
  requestId: number;
  closureStatus: null;
  closedAt: null;
  closureReason: string;
  handlingResult: RepairRequestHandlingResult.INTERRUPTED;
  handlingStatus: RepairRequestHandlingStatus.IN_PROGRESS;
  handlingEndedAt: null;
};

/**
 * 记录维修中断（与结单分离）。
 *
 * - 仅接单工程师本人、可信服务公司一致时可记录；
 * - 中断原因必填；
 * - 不写 closure_status / closed_at / handling_ended_at，工单仍可继续保存和回复；
 * - 已结单或处理状态已终结时失败关闭，避免把终结工单改回处理中。
 */
@Injectable()
export class InterruptRepairRequestUsecase {
  constructor(
    private readonly repairRequestService: RepairRequestService,
    private readonly trustedOrganizationContext: TrustedOrganizationContextQueryService,
    private readonly localWriteHoldService: LocalWriteHoldService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: InterruptRepairRequestCommand): Promise<RepairRequestInterruptionView> {
    assertEngineerWritePermission(command.session, '记录维修中断');
    assertRepairRequestId(command.requestId);
    const reason = normalizeClosureReason(command.reason, RepairRequestHandlingResult.INTERRUPTED);
    if (reason === null) {
      throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '维修中断必须填写原因');
    }
    const now = new Date();

    return this.transactionRunner.run(async (transactionContext) => {
      const membership = await this.trustedOrganizationContext.resolveForAccount({
        accountId: command.session.accountId,
        transactionContext,
      });
      const target = await this.repairRequestService.findProcessWriteTargetForUpdate(
        command.requestId,
        transactionContext,
      );
      this.assertInterruptibleTarget(target, command, membership.organizationId);

      // 恢复期写入冻结：该工单所属公司数据区正在恢复时不得记录中断（写入会被整体替换掉）
      await this.localWriteHoldService.assertBusinessWritableInTransaction({
        organizationId: target?.ownerOrganizationId ?? null,
        transactionContext,
      });

      const affected = await this.repairRequestService.recordInterruption(
        {
          requestId: command.requestId,
          engineerAccountId: command.session.accountId,
          reason,
          recordedAt: now,
        },
        transactionContext,
      );
      if (affected !== 1) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.CLOSED_STATE_CONFLICT,
          '工单已结单或状态已变化，请刷新后重试',
          { requestId: command.requestId },
        );
      }

      return {
        requestId: command.requestId,
        closureStatus: null,
        closedAt: null,
        closureReason: reason,
        handlingResult: RepairRequestHandlingResult.INTERRUPTED,
        handlingStatus: RepairRequestHandlingStatus.IN_PROGRESS,
        handlingEndedAt: null,
      };
    });
  }

  private assertInterruptibleTarget(
    target: RepairProcessBindingTargetSnapshot | null,
    command: InterruptRepairRequestCommand,
    viewerOrganizationId: number,
  ): void {
    if (
      !target ||
      target.deprecated ||
      target.serviceOrganizationId === null ||
      target.serviceOrganizationId !== viewerOrganizationId
    ) {
      throw new DomainError(REPAIR_REQUEST_ERROR.NOT_FOUND, '维修申请不存在或不可操作', {
        requestId: command.requestId,
      });
    }
    if (!target.isAccepted || target.acceptedByEngineerAccountId !== command.session.accountId) {
      throw new DomainError(REPAIR_REQUEST_ERROR.NOT_ACCEPTED, '仅接单工程师可以记录维修中断', {
        requestId: command.requestId,
      });
    }
    if (isRepairRequestEnded(target)) {
      throw new DomainError(REPAIR_REQUEST_ERROR.CLOSED_STATE_CONFLICT, '工单已结单', {
        requestId: command.requestId,
      });
    }
    if (
      target.handlingStatus !== null &&
      isTerminalHandlingStatus(target.handlingStatus as RepairRequestHandlingStatus)
    ) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.CLOSED_STATE_CONFLICT,
        '工单处理状态已终结，不能记录中断',
        { requestId: command.requestId },
      );
    }
  }
}
