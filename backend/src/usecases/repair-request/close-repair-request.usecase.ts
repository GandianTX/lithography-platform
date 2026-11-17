// src/usecases/repair-request/close-repair-request.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import { DomainError, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import { isRepairRequestEnded } from '@core/repair-request/policy/repair-process-write.policy';
import {
  isTerminalHandlingStatus,
  resolveRepairRequestHandlingStatus,
} from '@core/repair-request/policy/repair-request-handling.policy';
import { normalizeClosureReason } from '@core/repair-request/policy/repair-request-write-normalize.policy';
import { Inject, Injectable } from '@nestjs/common';
import type { RepairProcessBindingTargetSnapshot } from '@src/modules/lithography/lithography.types';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { assertRepairRequestId } from './assert-repair-request-id';
import { assertEngineerWritePermission } from './engineer-write-permission';

export type CloseRepairRequestCommand = {
  session: UsecaseSession;
  requestId: number;
  handlingResult: RepairRequestHandlingResult;
  /** 中断/无法修复必须填写原因；其他结果可选 */
  closureReason?: string | null;
};

export type RepairRequestClosureView = {
  requestId: number;
  closureStatus: string;
  closedAt: Date;
  closureReason: string | null;
  handlingResult: RepairRequestHandlingResult;
  handlingStatus: RepairRequestHandlingStatus;
  handlingEndedAt: Date | null;
};

/**
 * 工单结单用例（任务 04 第一轮）。
 *
 * - 仅工单接单工程师本人、同组织可结单；非接单人或跨公司失败关闭；
 * - 五类结果经固定策略映射为三态处理状态，客户端不能自报状态；
 * - 中断（IN_PROGRESS）不写 handling_ended_at，结单事实由 closure_status/closed_at 表达；
 * - 结单与回复互相独立：本用例不删除、不改写任何回复记录，也不依赖回复存在；
 * - 结单后内部过程与回复由各自写用例按 CLOSED_STATE_CONFLICT 拒绝写入。
 */
@Injectable()
export class CloseRepairRequestUsecase {
  constructor(
    private readonly repairRequestService: RepairRequestService,
    private readonly trustedOrganizationContext: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: CloseRepairRequestCommand): Promise<RepairRequestClosureView> {
    assertEngineerWritePermission(command.session, '结单');
    assertRepairRequestId(command.requestId);
    const handlingResult = normalizeHandlingResult(command.handlingResult);
    const closureReason = normalizeClosureReason(command.closureReason, handlingResult);
    const now = new Date();
    const handlingStatus = resolveRepairRequestHandlingStatus(handlingResult);
    const handlingEndedAt = isTerminalHandlingStatus(handlingStatus) ? now : null;

    return this.transactionRunner.run(async (transactionContext) => {
      const membership = await this.trustedOrganizationContext.resolveForAccount({
        accountId: command.session.accountId,
        transactionContext,
      });
      const target = await this.repairRequestService.findProcessWriteTargetForUpdate(
        command.requestId,
        transactionContext,
      );
      this.assertClosableTarget(target, command, membership.organizationId);

      const affected = await this.repairRequestService.closeRequest(
        {
          requestId: command.requestId,
          engineerAccountId: command.session.accountId,
          handlingResult,
          handlingStatus,
          handlingEndedAt,
          closureReason,
          closedAt: now,
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
        closureStatus: 'CLOSED',
        closedAt: now,
        closureReason,
        handlingResult,
        handlingStatus,
        handlingEndedAt,
      };
    });
  }

  private assertClosableTarget(
    target: RepairProcessBindingTargetSnapshot | null,
    command: CloseRepairRequestCommand,
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
      throw new DomainError(REPAIR_REQUEST_ERROR.NOT_ACCEPTED, '仅接单工程师可以结单', {
        requestId: command.requestId,
      });
    }
    if (isRepairRequestEnded(target)) {
      throw new DomainError(REPAIR_REQUEST_ERROR.CLOSED_STATE_CONFLICT, '工单已结单', {
        requestId: command.requestId,
      });
    }
  }
}

function normalizeHandlingResult(value: RepairRequestHandlingResult): RepairRequestHandlingResult {
  if (!Object.values(RepairRequestHandlingResult).includes(value)) {
    throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '处理结果不合法');
  }
  return value;
}
