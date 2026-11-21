// src/usecases/maintenance-report/create-maintenance-report-draft.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { MaintenanceReportSourceType } from '@app-types/models/maintenance-report.types';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { RepairRequestWriteContext } from '@src/modules/lithography/maintenance-report.types';
import { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { RepairRequestMaintenanceQueryService } from '@src/modules/lithography/queries/repair-request-maintenance.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { StoredFileService } from '@src/modules/lithography/stored-file.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import {
  CreateMaintenanceReportCommand,
  MaintenanceReportDraftMutationResult,
} from './maintenance-report-command.types';
import {
  bindStagedAttachmentToReport,
  normalizeStagedAttachment,
  type NormalizedStagedAttachment,
} from './maintenance-report-attachment-binding.helpers';
import {
  normalizeMaintenanceReportDraft,
  normalizeSourceType,
} from './maintenance-report.input.normalize';
import {
  assertMaintenanceReportAuthorRole,
  assertMaintenanceReportId,
} from './maintenance-report-roles';
import { assertWorkOrderSummaryPreconditions } from './maintenance-report-work-order.constants';
import {
  assertNoWorkOrderSummaryClientContent,
  buildWorkOrderSummaryDraftInput,
  readWorkOrderSummarySourceFacts,
} from './maintenance-report-work-order-source.helpers';

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
 * 6. 可选暂存原件：R050-01/R045-02 首存同事务绑定并登记附件行（含 file_id）
 */
@Injectable()
export class CreateMaintenanceReportDraftUsecase {
  constructor(
    private readonly maintenanceReportService: MaintenanceReportService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    private readonly equipmentModelQueryService: EquipmentModelQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly storedFileService: StoredFileService,
    private readonly maintenanceQueryService: RepairRequestMaintenanceQueryService,
    private readonly organizationQueryService: OrganizationQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: CreateMaintenanceReportCommand,
  ): Promise<MaintenanceReportDraftMutationResult> {
    assertMaintenanceReportAuthorRole(command.session);
    const sourceType = normalizeSourceType(command.sourceType);
    const repairRequestId = normalizeRepairRequestId(sourceType, command.repairRequestId);
    // 2026-11-20 需求调整：工单总结只读核对——客户端不携带内容字段，
    // 服务端在事务内以核验后的工单事实派生草稿；也不接受总结自带原件
    if (sourceType === MaintenanceReportSourceType.WORK_ORDER_SUMMARY) {
      assertNoWorkOrderSummaryClientContent(command.draft);
      if (command.attachment !== null && command.attachment !== undefined) {
        throw new DomainError(
          MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
          '工单维修总结不单独登记报告原件，来源工单原件按工单权限读取',
        );
      }
    }
    const draft =
      sourceType === MaintenanceReportSourceType.WORK_ORDER_SUMMARY
        ? null
        : normalizeMaintenanceReportDraft(command.draft, command.session.accountId);
    // R050-01/R045-02：首存可携带暂存原件；file_id/上下文形态在事务前核验
    const attachment = normalizeStagedAttachment(command.attachment);

    return this.transactionRunner.run((transactionContext) =>
      this.doCreate(command, sourceType, repairRequestId, draft, attachment, transactionContext),
    );
  }

  private async doCreate(
    command: CreateMaintenanceReportCommand,
    sourceType: MaintenanceReportSourceType,
    repairRequestId: number | null,
    draft: ReturnType<typeof normalizeMaintenanceReportDraft> | null,
    attachment: NormalizedStagedAttachment,
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

    if (draft !== null && draft.equipmentModelId !== null) {
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
      assertWorkOrderSummaryPreconditions({
        request: workOrder,
        repairRequestId,
        accountId: command.session.accountId,
        organizationId: membership.organizationId,
      });
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

    // 工单总结：以锁定工单后的服务端事实派生草稿（含表头/步骤/故障/结果字段）
    const effectiveDraft =
      draft ??
      (await this.deriveWorkOrderSummaryDraft(
        workOrder as RepairRequestWriteContext,
        command.session.accountId,
        transactionContext,
      ));

    const nicknames = await this.accountQueryService.findNicknamesByAccountIds([
      command.session.accountId,
    ]);
    const engineerName = nicknames.get(command.session.accountId) ?? ENGINEER_NAME_FALLBACK;

    const report = await this.maintenanceReportService.insertReport(
      {
        ownerOrganizationId: membership.organizationId,
        sourceType,
        repairRequestId,
        title: effectiveDraft.title,
        customerFactoryName: effectiveDraft.customerFactoryName,
        equipmentModelId: effectiveDraft.equipmentModelId,
        equipmentModelText: effectiveDraft.equipmentModelText,
        maintenanceDate: effectiveDraft.maintenanceDate,
        maintenanceEngineerAccountId: command.session.accountId,
        maintenanceEngineerNameSnapshot: engineerName,
        phaseFlowVersion: CURRENT_PHASE_FLOW_VERSION,
        createdByAccountId: command.session.accountId,
        updatedByAccountId: command.session.accountId,
      },
      transactionContext,
    );

    // R050-01/R045-02：报告根落库后同事务绑定暂存原件并登记附件行（含 file_id）；
    // 绑定失败随本事务整体回滚，不留半份草稿或被占用的暂存原件
    if (attachment !== null) {
      await bindStagedAttachmentToReport({
        storedFileService: this.storedFileService,
        maintenanceReportService: this.maintenanceReportService,
        maintenanceReportQueryService: this.maintenanceReportQueryService,
        reportId: report.id,
        ownerOrganizationId: membership.organizationId,
        accountId: command.session.accountId,
        attachment,
        transactionContext,
      });
    }

    await this.maintenanceReportService.updateDraft(report.id, effectiveDraft, transactionContext);
    await this.maintenanceReportService.replaceAlarms(
      report.id,
      effectiveDraft.alarms,
      transactionContext,
    );
    await this.maintenanceReportService.replaceSteps(
      report.id,
      effectiveDraft.steps,
      transactionContext,
    );
    // 故障分支的 STEP_NEW_FAULT 依赖步骤复合外键，必须在步骤落库之后写入
    await this.maintenanceReportService.replaceFaults(
      report.id,
      effectiveDraft.faults,
      transactionContext,
    );

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

  /** 工单总结派生：核验后的工单事实 → 报告草稿写入数据（AI 评价缺省 NOT_USED） */
  private async deriveWorkOrderSummaryDraft(
    workOrder: RepairRequestWriteContext,
    accountId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<ReturnType<typeof normalizeMaintenanceReportDraft>> {
    const facts = await readWorkOrderSummarySourceFacts({
      request: workOrder,
      maintenanceQueryService: this.maintenanceQueryService,
      organizationQueryService: this.organizationQueryService,
      transactionContext,
    });
    return normalizeMaintenanceReportDraft(buildWorkOrderSummaryDraftInput(facts), accountId, {
      // 工单总结派生复用结单侧（任务 04）结单原因规则：非终结结果原因可选
      allowNonTerminalClosureReason: true,
    });
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
