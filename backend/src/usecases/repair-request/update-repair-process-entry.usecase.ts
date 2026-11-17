// src/usecases/repair-request/update-repair-process-entry.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  DomainError,
  REPAIR_REQUEST_ERROR,
  STORED_FILE_ERROR,
} from '@core/common/errors/domain-error';
import { isRepairRequestEnded } from '@core/repair-request/policy/repair-process-write.policy';
import {
  normalizeProcessOccurredAt,
  normalizeProcessOperationText,
  normalizeProcessOriginalFile,
  normalizeProcessTestResult,
  normalizeRepairProcessEntryId,
  normalizeRepairProcessExpectedVersion,
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

export type UpdateRepairProcessEntryCommand = {
  session: UsecaseSession;
  requestId: number;
  entryId: string;
  expectedVersion: number;
  operationText: string;
  testResult?: string | null;
  occurredAt?: string | null;
  /**
   * 可选：仅当前过程尚无原件时补传一份暂存原件。
   * 省略表示保持原绑定不变；明确 `null` 不被解释为移除原件，按输入错误拒绝。
   */
  file?: { fileId: string; uploadContextId: string } | null;
};

/**
 * 内部维修过程编辑用例。
 *
 * - 仅作者本人、工单接单人、同组织可编辑；
 * - 工单已结单/处理已终结时只读；
 * - `expected_version` 与当前版本不一致返回 PROCESS_VERSION_CONFLICT；
 * - 未传 `file` 时原绑定与 fileId 保持不变；
 * - 传 `file` 时先走任务 11 绑定用例（原件锁 → 工单锁），再锁过程行并按
 *   `(version_no, file_id IS NULL)` 条件更新；过程已有原件则返回 PROCESS_ORIGINAL_IMMUTABLE，
 *   绑定与过程更新共用调用方事务，任一失败整体回滚。
 */
@Injectable()
export class UpdateRepairProcessEntryUsecase {
  constructor(
    private readonly repairRequestService: RepairRequestService,
    private readonly repairProcessEntryService: RepairProcessEntryService,
    private readonly bindRepairProcessOriginalUsecase: BindRepairProcessOriginalUsecase,
    private readonly trustedOrganizationContext: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: UpdateRepairProcessEntryCommand): Promise<RepairProcessEntrySnapshot> {
    assertEngineerWritePermission(command.session, '编辑内部维修过程');
    assertRepairRequestId(command.requestId);
    const entryId = normalizeRepairProcessEntryId(command.entryId);
    const expectedVersion = normalizeRepairProcessExpectedVersion(command.expectedVersion);
    const operationText = normalizeProcessOperationText(command.operationText);
    const testResult = normalizeProcessTestResult(command.testResult);
    const occurredAt = normalizeProcessOccurredAt(command.occurredAt);
    const file = this.normalizeOptionalFile(command.file);
    const timeSource = occurredAt === null ? 'SERVER' : 'MANUAL';
    const eventTime = occurredAt ?? new Date();

    return this.transactionRunner.run(async (transactionContext) => {
      // 锁顺序与创建路径一致：原件（任务 11 绑定内）→ 工单 → 过程行
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

      const current = await this.repairProcessEntryService.findForUpdate(
        command.requestId,
        entryId,
        transactionContext,
      );
      if (!current || current.authorAccountId !== command.session.accountId) {
        throw new DomainError(REPAIR_REQUEST_ERROR.PROCESS_NOT_FOUND, '维修过程不存在或无权编辑', {
          requestId: command.requestId,
          entryId,
        });
      }
      if (current.versionNo !== expectedVersion) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.PROCESS_VERSION_CONFLICT,
          '维修过程已被修改，请刷新后重试',
          { requestId: command.requestId, entryId, expectedVersion },
        );
      }
      if (file && current.fileId !== null) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.PROCESS_ORIGINAL_IMMUTABLE,
          '该维修过程已绑定原件，编辑不能替换或移除；如需追加原件请新建过程记录',
          { requestId: command.requestId, entryId },
        );
      }

      const affected = await this.repairProcessEntryService.updateWithVersion(
        {
          requestId: command.requestId,
          entryId,
          authorAccountId: command.session.accountId,
          expectedVersion,
          operationText,
          testResult,
          occurredAt: eventTime,
          timeSource,
          ...(file ? { fileId: file.fileId } : {}),
        },
        transactionContext,
      );
      if (affected !== 1) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.PROCESS_VERSION_CONFLICT,
          '维修过程已被修改，请刷新后重试',
          { requestId: command.requestId, entryId, expectedVersion },
        );
      }

      return {
        ...current,
        operationText,
        testResult,
        occurredAt: eventTime,
        timeSource,
        fileId: file ? file.fileId : current.fileId,
        versionNo: expectedVersion + 1,
      };
    });
  }

  /** 区分「未传 file」与「明确传空值」：后者不得被解释为移除原件 */
  private normalizeOptionalFile(
    file: UpdateRepairProcessEntryCommand['file'],
  ): { fileId: string; uploadContextId: string } | null {
    if (file === undefined) {
      return null;
    }
    if (file === null) {
      throw new DomainError(
        STORED_FILE_ERROR.INVALID_PARAMS,
        '编辑不支持移除或清空原件；未传 file 表示保持原件不变',
      );
    }
    return normalizeProcessOriginalFile(file);
  }

  private assertWritableTarget(
    target: RepairProcessBindingTargetSnapshot | null,
    command: UpdateRepairProcessEntryCommand,
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
      throw new DomainError(REPAIR_REQUEST_ERROR.NOT_ACCEPTED, '仅接单工程师可以编辑维修过程', {
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
