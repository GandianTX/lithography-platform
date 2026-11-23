// src/usecases/repair-request/save-repair-request-maintenance.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import {
  normalizeMaintenanceRecord,
  type MaintenanceRecordRawInput,
} from '@core/repair-request/policy/repair-request-maintenance.policy';
import { isRepairRequestEnded } from '@core/repair-request/policy/repair-process-write.policy';
import { Inject, Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type {
  RepairMaintenanceFaultPanelView,
  RepairMaintenanceRecordView,
  RepairMaintenanceStepView,
  RepairRequestMaintenanceTargetSnapshot,
} from '@src/modules/lithography/lithography.types';
import { RepairRequestMaintenanceQueryService } from '@src/modules/lithography/queries/repair-request-maintenance.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { RepairRequestMaintenanceService } from '@src/modules/lithography/repair-request-maintenance.service';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { assertRepairRequestId } from './assert-repair-request-id';
import { BindRepairProcessOriginalUsecase } from './bind-repair-process-original.usecase';
import { assertEngineerWritePermission } from './engineer-write-permission';

export type SaveRepairRequestMaintenanceCommand = {
  session: UsecaseSession;
  requestId: number;
  expectedVersion: number;
  attachment?: { fileId: string; uploadContextId: string } | null;
  maintenanceDate?: string | null;
  engineerName?: string | null;
  resetResult?: string | null;
  supplementaryNote?: string | null;
  steps: MaintenanceRecordRawInput['steps'];
  panels: MaintenanceRecordRawInput['panels'];
};

export type SaveRepairRequestMaintenanceResult = {
  record: RepairMaintenanceRecordView;
  steps: RepairMaintenanceStepView[];
  panels: RepairMaintenanceFaultPanelView[];
};

/**
 * 结构化内部维修记录保存用例（任务 04）。
 *
 * 原子性：
 * - 同一事务内完成（可选）原件绑定、步骤/面板差异写入、工单维修字段与版本推进；
 * - 任一步失败整体回滚，不留下「原件已绑定但记录未保存」或半套步骤/面板；
 * - 不新增草稿表：保存即生效，刷新后可继续编辑。
 *
 * 授权与状态（失败关闭）：
 * - 仅 activeRole 精确为 ENGINEER；
 * - 工单可信服务公司必须来自报修原始输入且与当前账号可信组织一致，
 *   不回退旧 owner、客户公司、历史接单人或客户端组织；
 * - 仅接单本人、未作废、未终结可写；结单后只读；
 * - expectedVersion 必须等于当前 maintenance_version_no。
 */
@Injectable()
export class SaveRepairRequestMaintenanceUsecase {
  constructor(
    private readonly maintenanceService: RepairRequestMaintenanceService,
    private readonly maintenanceQueryService: RepairRequestMaintenanceQueryService,
    private readonly trustedOrganizationContext: TrustedOrganizationContextQueryService,
    private readonly localWriteHoldService: LocalWriteHoldService,
    private readonly bindOriginalUsecase: BindRepairProcessOriginalUsecase,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    @Inject(AccountQueryService)
    private readonly accountQueryService?: AccountQueryService,
  ) {}

  async execute(
    command: SaveRepairRequestMaintenanceCommand,
  ): Promise<SaveRepairRequestMaintenanceResult> {
    assertEngineerWritePermission(command.session, '保存维修记录');
    assertRepairRequestId(command.requestId);
    if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0) {
      throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '维修记录版本号不合法');
    }

    const normalized = normalizeMaintenanceRecord({
      maintenanceDate: command.maintenanceDate,
      // 姓名快照只取工单接单账号的可信资料；客户端值即使非空也不参与归一化
      engineerName: null,
      resetResult: command.resetResult,
      supplementaryNote: command.supplementaryNote,
      steps: command.steps,
      panels: command.panels,
    });

    if (command.attachment) {
      // 事务前快速失败：避免已绑定工单白白消费一份新原件（并发仍由事务内条件更新兜底）
      const current = await this.maintenanceService.findTarget(command.requestId);
      if (current !== null && current.maintenanceAttachmentFileId !== null) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.PROCESS_ORIGINAL_IMMUTABLE,
          '工单已绑定维修原件，不能替换',
          { requestId: command.requestId },
        );
      }
    }

    // 回执必须在事务内读取：提交成功才返回，失败/回滚不会留下“已保存”的假象
    return this.transactionRunner.run(async (transactionContext) => {
      const membership = await this.trustedOrganizationContext.resolveForAccount({
        accountId: command.session.accountId,
        transactionContext,
      });

      if (command.attachment) {
        // 锁顺序遵循任务 11 契约：先原件、后工单；绑定与后续写入同事务
        await this.bindOriginalUsecase.executeInTransaction(
          {
            session: command.session,
            requestId: command.requestId,
            fileId: command.attachment.fileId,
            uploadContextId: command.attachment.uploadContextId,
          },
          transactionContext,
        );
      }

      const target = this.assertWritableTarget(
        await this.maintenanceService.findTargetForUpdate(command.requestId, transactionContext),
        command,
        membership.organizationId,
      );

      // 恢复期写入冻结：该工单所属公司数据区正在恢复时不得保存维修记录
      await this.localWriteHoldService.assertBusinessWritable({
        organizationId: target.ownerOrganizationId,
      });

      const engineerName = await this.resolveTrustedEngineerName(
        target.acceptedByEngineerAccountId!,
        transactionContext,
      );

      if (command.attachment) {
        await this.maintenanceService.attachMaintenanceFile(
          command.requestId,
          command.attachment.fileId,
          command.expectedVersion,
          transactionContext,
        );
      }

      await this.maintenanceService.saveMaintenance(
        {
          requestId: command.requestId,
          expectedVersion: command.expectedVersion,
          maintenanceDate: normalized.maintenanceDate,
          engineerName,
          resetResult: normalized.resetResult,
          supplementaryNote: normalized.supplementaryNote,
          steps: normalized.steps,
          panels: normalized.panels,
        },
        transactionContext,
      );

      const record = await this.maintenanceQueryService.findRecord(
        command.requestId,
        transactionContext,
      );
      if (!record) {
        throw new DomainError(REPAIR_REQUEST_ERROR.NOT_FOUND, '维修申请不存在');
      }
      return {
        record,
        steps: await this.maintenanceQueryService.listSteps(command.requestId, transactionContext),
        panels: await this.maintenanceQueryService.listFaultPanels(
          command.requestId,
          transactionContext,
        ),
      };
    });
  }

  /**
   * 按工单接单账号读取可信姓名；缺失时失败关闭，绝不以表单值/其他账号兜底。
   */
  private async resolveTrustedEngineerName(
    acceptedByEngineerAccountId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<string> {
    const realName = await this.accountQueryService?.findRealNameByAccountId({
      accountId: acceptedByEngineerAccountId,
      transactionContext,
    });
    if (!realName) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.ENGINEER_PROFILE_INCOMPLETE,
        '接单工程师资料缺少真实姓名，无法保存维修记录，请联系管理员补全资料',
      );
    }
    return realName;
  }

  private assertWritableTarget(
    target: RepairRequestMaintenanceTargetSnapshot | null,
    command: SaveRepairRequestMaintenanceCommand,
    viewerOrganizationId: number,
  ): RepairRequestMaintenanceTargetSnapshot {
    if (
      !target ||
      target.deprecated ||
      target.serviceOrganizationId === null ||
      target.serviceOrganizationId !== viewerOrganizationId
    ) {
      // 与既有工程师入口一致：不可访问统一 NOT_FOUND，不泄露归属
      throw new DomainError(REPAIR_REQUEST_ERROR.NOT_FOUND, '维修申请不存在或不可操作', {
        requestId: command.requestId,
      });
    }
    if (!target.isAccepted || target.acceptedByEngineerAccountId !== command.session.accountId) {
      throw new DomainError(REPAIR_REQUEST_ERROR.NOT_ACCEPTED, '仅接单工程师可以保存维修记录', {
        requestId: command.requestId,
      });
    }
    if (isRepairRequestEnded(target)) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.CLOSED_STATE_CONFLICT,
        '工单已结束，维修记录只读',
        {
          requestId: command.requestId,
        },
      );
    }
    if (target.maintenanceVersionNo !== command.expectedVersion) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.PROCESS_VERSION_CONFLICT,
        '维修记录已被其他人更新，请刷新后重试',
        { requestId: command.requestId },
      );
    }
    if (command.attachment && target.maintenanceAttachmentFileId !== null) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.PROCESS_ORIGINAL_IMMUTABLE,
        '工单已绑定维修原件，不能替换',
        { requestId: command.requestId },
      );
    }
    return target;
  }
}
