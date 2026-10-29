// src/usecases/maintenance-report/create-maintenance-report-draft.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { MaintenanceReportSourceType } from '@app-types/models/maintenance-report.types';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import type { RepairRequestWriteContext } from '@src/modules/lithography/maintenance-report.types';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import {
  CreateMaintenanceReportCommand,
  MaintenanceReportDraftMutationResult,
} from './maintenance-report-command.types';
import {
  normalizeMaintenanceReportDraft,
  normalizeSourceType,
} from './maintenance-report.input.normalize';
import {
  assertMaintenanceReportAuthorRole,
  assertMaintenanceReportId,
} from './maintenance-report-roles';

/** 负责人姓名快照缺失时的安全回落（与工单链路「工程师」口径一致） */
const ENGINEER_NAME_FALLBACK = '工程师';

/** 本期阶段流程版本固定为 1（稳定编码 PHASE_01—PHASE_10） */
const CURRENT_PHASE_FLOW_VERSION = 1;

/**
 * 新建维修报告草稿用例。
 *
 * 1. 角色：仅真实 ENGINEER（精确 activeRole）
 * 2. 来源：WORK_ORDER_SUMMARY 必须关联工单且由本人接单、同组织；HISTORICAL_CASE 不得带工单
 * 3. 组织：事务内经可信组织上下文解析，不接受客户端自报；负责人取自 Session
 * 4. 一工单一份总结根（应用层预检 + 数据库唯一键兜底）
 * 5. 报告根与初始内容（报警/步骤/AI 标记）同事务落库
 */
@Injectable()
export class CreateMaintenanceReportDraftUsecase {
  constructor(
    private readonly maintenanceReportService: MaintenanceReportService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    private readonly equipmentModelQueryService: EquipmentModelQueryService,
    private readonly accountQueryService: AccountQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: CreateMaintenanceReportCommand,
  ): Promise<MaintenanceReportDraftMutationResult> {
    assertMaintenanceReportAuthorRole(command.session);
    const sourceType = normalizeSourceType(command.sourceType);
    const repairRequestId = normalizeRepairRequestId(sourceType, command.repairRequestId);
    const draft = normalizeMaintenanceReportDraft(command.draft, command.session.accountId);

    return this.transactionRunner.run((transactionContext) =>
      this.doCreate(command, sourceType, repairRequestId, draft, transactionContext),
    );
  }

  private async doCreate(
    command: CreateMaintenanceReportCommand,
    sourceType: MaintenanceReportSourceType,
    repairRequestId: number | null,
    draft: ReturnType<typeof normalizeMaintenanceReportDraft>,
    transactionContext: PersistenceTransactionContext,
  ): Promise<MaintenanceReportDraftMutationResult> {
    // 行锁必须作为本事务的第一次读取：先锁工单再解析组织，
    // 锁后的普通读（型号是否存在、是否已有总结）才落在最新已提交视图上，
    // 并发建稿才会被预检拦下，而不是落到唯一键冲突。
    const workOrder =
      repairRequestId === null
        ? null
        : await this.maintenanceReportService.readRepairRequestWriteContext(
            repairRequestId,
            transactionContext,
          );

    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
      transactionContext,
    });

    if (draft.equipmentModelId !== null) {
      const model = await this.equipmentModelQueryService.findModelById({
        id: draft.equipmentModelId,
        transactionContext,
      });
      if (!model) {
        throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '设备型号不存在', {
          equipmentModelId: draft.equipmentModelId,
        });
      }
    }

    if (repairRequestId !== null) {
      this.assertWorkOrderSummaryPreconditions(
        workOrder,
        repairRequestId,
        command.session.accountId,
        membership.organizationId,
      );
      const exists = await this.maintenanceReportQueryService.hasWorkOrderSummary(
        repairRequestId,
        transactionContext,
      );
      if (exists) {
        throw new DomainError(
          MAINTENANCE_REPORT_ERROR.WORK_ORDER_ALREADY_SUMMARIZED,
          '该工单已存在维修总结',
          { repairRequestId },
        );
      }
    }

    const nicknames = await this.accountQueryService.findNicknamesByAccountIds([
      command.session.accountId,
    ]);
    const engineerName = nicknames.get(command.session.accountId) ?? ENGINEER_NAME_FALLBACK;

    const report = await this.maintenanceReportService.insertReport(
      {
        ownerOrganizationId: membership.organizationId,
        sourceType,
        repairRequestId,
        title: draft.title,
        customerFactoryName: draft.customerFactoryName,
        equipmentModelId: draft.equipmentModelId,
        equipmentModelText: draft.equipmentModelText,
        maintenanceDate: draft.maintenanceDate,
        maintenanceEngineerAccountId: command.session.accountId,
        maintenanceEngineerNameSnapshot: engineerName,
        phaseFlowVersion: CURRENT_PHASE_FLOW_VERSION,
        createdByAccountId: command.session.accountId,
        updatedByAccountId: command.session.accountId,
      },
      transactionContext,
    );

    await this.maintenanceReportService.updateDraft(report.id, draft, transactionContext);
    await this.maintenanceReportService.replaceAlarms(report.id, draft.alarms, transactionContext);
    await this.maintenanceReportService.replaceSteps(report.id, draft.steps, transactionContext);

    const saved = await this.maintenanceReportQueryService.readReport(
      report.id,
      transactionContext,
    );
    if (!saved) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.CREATION_FAILED, '维修报告创建失败');
    }
    return {
      reportId: saved.id,
      status: saved.status,
      currentVersionNo: saved.currentVersionNo,
      updatedAt: saved.updatedAt,
    };
  }

  /** 工单总结前置事实：工单存在、未撤回、已接单且接单人为本组织本人 */
  private assertWorkOrderSummaryPreconditions(
    request: RepairRequestWriteContext | null,
    repairRequestId: number,
    accountId: number,
    organizationId: number,
  ): void {
    if (request === null || request.deprecated) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '工单不存在或已撤回', {
        repairRequestId,
      });
    }
    if (!request.isAccepted || request.acceptedEngineerAccountId === null) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.WORK_ORDER_NOT_ACCEPTED,
        '工单尚未由工程师接单，不能创建维修总结',
        { repairRequestId },
      );
    }
    if (request.acceptedEngineerAccountId !== accountId) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.WORK_ORDER_OWNER_MISMATCH,
        '工单不存在或不可访问',
        { repairRequestId },
      );
    }
    if (request.ownerOrganizationId !== organizationId) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.WORK_ORDER_OWNER_MISMATCH,
        '工单不存在或不可访问',
        { repairRequestId },
      );
    }
  }
}

function normalizeRepairRequestId(
  sourceType: MaintenanceReportSourceType,
  repairRequestId: number | null | undefined,
): number | null {
  if (sourceType === MaintenanceReportSourceType.HISTORICAL_CASE) {
    if (repairRequestId !== null && repairRequestId !== undefined) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
        '历史故障案例不能关联系统工单',
        { repairRequestId },
      );
    }
    return null;
  }
  if (repairRequestId === null || repairRequestId === undefined) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '工单总结必须关联工单');
  }
  assertMaintenanceReportId(repairRequestId);
  return repairRequestId;
}
