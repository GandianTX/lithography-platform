// src/usecases/repair-request/create-repair-process-entry.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { DomainError, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import { isRepairRequestEnded } from '@core/repair-request/policy/repair-process-write.policy';
import {
  normalizeProcessOccurredAt,
  normalizeProcessOperationText,
  normalizeProcessOriginalFile,
  normalizeProcessTestResult,
} from '@core/repair-request/policy/repair-request-write-normalize.policy';
import { Inject, Injectable } from '@nestjs/common';
import type {
  RepairProcessBindingTargetSnapshot,
  RepairProcessEntrySnapshot,
} from '@src/modules/lithography/lithography.types';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { RepairProcessEntryService } from '@src/modules/lithography/repair-process-entry.service';
import { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { assertRepairRequestId } from './assert-repair-request-id';
import { BindRepairProcessOriginalUsecase } from './bind-repair-process-original.usecase';
import { assertEngineerWritePermission } from './engineer-write-permission';

export type CreateRepairProcessEntryCommand = {
  session: UsecaseSession;
  requestId: number;
  operationText: string;
  testResult?: string | null;
  /** 业务现场事件时间（ISO 字符串）；缺省时使用服务端时间 */
  occurredAt?: string | null;
  /** 可选的暂存原件：保存过程与绑定原件必须在同一事务内完成 */
  file?: { fileId: string; uploadContextId: string } | null;
};

/**
 * 内部维修过程创建用例（任务 04 第一轮主链）。
 *
 * - 仅精确 ENGINEER 身份、工单接单人本人、同组织可写；
 * - 工单已删除/不存在按 NOT_FOUND，未接单或非本人按 NOT_ACCEPTED，已结单/终结按 CLOSED_STATE_CONFLICT；
 * - 携带原件时先走任务 11 绑定用例（原件锁 → 工单锁），再插入引用该 fileId 的过程记录；
 *   两者共用调用方事务，任一失败整体回滚；
 * - 作者仅取自 Session，时间来源由服务端按输入事实固定写入。
 */
@Injectable()
export class CreateRepairProcessEntryUsecase {
  constructor(
    private readonly repairRequestService: RepairRequestService,
    private readonly repairProcessEntryService: RepairProcessEntryService,
    private readonly bindRepairProcessOriginalUsecase: BindRepairProcessOriginalUsecase,
    private readonly trustedOrganizationContext: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: CreateRepairProcessEntryCommand): Promise<RepairProcessEntrySnapshot> {
    assertEngineerWritePermission(command.session, '记录内部维修过程');
    assertRepairRequestId(command.requestId);
    // 任务 04 旧过程已转为历史只读：保留旧 API 形状，但后端拒绝一切新增/改绑。
    this.rejectLegacyProcessWrite(command.requestId);

    const operationText = normalizeProcessOperationText(command.operationText);
    const testResult = normalizeProcessTestResult(command.testResult);
    const occurredAt = normalizeProcessOccurredAt(command.occurredAt);
    const file = normalizeProcessOriginalFile(command.file);
    const timeSource = occurredAt === null ? 'SERVER' : 'MANUAL';
    const eventTime = occurredAt ?? new Date();

    return this.transactionRunner.run(async (transactionContext) => {
      // 锁顺序：原件（任务 11 绑定内）→ 工单 → 过程行，与既有写入口保持一致
      if (file) {
        await this.bindRepairProcessOriginalUsecase.executeInTransaction(
          {
            session: command.session,
            requestId: command.requestId,
            fileId: file.fileId,
            uploadContextId: file.uploadContextId,
          },
          transactionContext,
        );
      }

      const membership = await this.trustedOrganizationContext.resolveForAccount({
        accountId: command.session.accountId,
        transactionContext,
      });
      const target = await this.repairRequestService.findProcessWriteTargetForUpdate(
        command.requestId,
        transactionContext,
      );
      this.assertWritableTarget(target, command, membership.organizationId);

      return this.repairProcessEntryService.insertEntry(
        {
          requestId: command.requestId,
          authorAccountId: command.session.accountId,
          operationText,
          testResult,
          occurredAt: eventTime,
          timeSource,
          fileId: file?.fileId ?? null,
        },
        transactionContext,
      );
    });
  }

  // 返回类型声明为 void：函数体始终抛错，但避免 TS 将后续旧实现判为不可达而丢失类型收窄。
  private rejectLegacyProcessWrite(requestId: number): void {
    throw new DomainError(
      REPAIR_REQUEST_ERROR.PROCESS_READONLY,
      '旧维修过程已只读，请使用结构化维修记录',
      { requestId },
    );
  }

  private assertWritableTarget(
    target: RepairProcessBindingTargetSnapshot | null,
    command: CreateRepairProcessEntryCommand,
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
      throw new DomainError(REPAIR_REQUEST_ERROR.NOT_ACCEPTED, '仅接单工程师可以记录维修过程', {
        requestId: command.requestId,
      });
    }
    if (isRepairRequestEnded(target)) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.CLOSED_STATE_CONFLICT,
        '工单已结单，内部维修过程只读',
        { requestId: command.requestId },
      );
    }
  }
}
