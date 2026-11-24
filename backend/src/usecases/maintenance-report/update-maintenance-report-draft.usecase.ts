// src/usecases/maintenance-report/update-maintenance-report-draft.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { MaintenanceReportSourceType } from '@app-types/models/maintenance-report.types';
import { MAINTENANCE_REPORT_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import type {
  MaintenanceReportDraftDetailView,
  RepairRequestWriteContext,
} from '@src/modules/lithography/maintenance-report.types';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { AiConversationQueryService } from '@src/modules/lithography/queries/ai-conversation.query.service';
import { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { RepairRequestMaintenanceQueryService } from '@src/modules/lithography/queries/repair-request-maintenance.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { StoredFileService } from '@src/modules/lithography/stored-file.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import type {
  MaintenanceReportDraftInput,
  MaintenanceReportDraftMutationResult,
  UpdateMaintenanceReportDraftCommand,
} from './maintenance-report-command.types';
import {
  ensureStagedAttachmentBinding,
  normalizeStagedAttachment,
  type NormalizedStagedAttachment,
} from './maintenance-report-attachment-binding.helpers';
import { normalizeMaintenanceReportDraft } from './maintenance-report.input.normalize';
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
import {
  assertWorkOrderSummaryAiEvaluationReference,
  resolveWorkOrderSummaryAiEvaluationInput,
} from './maintenance-report-ai-evaluation.helpers';
import { lockEditableReportForAuthor } from './maintenance-report-write-guard';

/**
 * 更新维修报告草稿（补丁语义：未提供的字段保持落库值，提供即整体替换）。
 *
 * 报警/步骤为整体替换：提供数组即重排/覆盖；未提供保持现状。
 * AI 评价按组覆盖：一旦提供任一 AI 字段，则按提供值重建该组，
 * 避免「只切换 NOT_USED」时残留旧评分触发数据库约束冲突。
 */
@Injectable()
export class UpdateMaintenanceReportDraftUsecase {
  constructor(
    private readonly maintenanceReportService: MaintenanceReportService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    private readonly localWriteHoldService: LocalWriteHoldService,
    private readonly equipmentModelQueryService: EquipmentModelQueryService,
    private readonly storedFileService: StoredFileService,
    private readonly maintenanceQueryService: RepairRequestMaintenanceQueryService,
    private readonly organizationQueryService: OrganizationQueryService,
    private readonly aiConversationQueryService: AiConversationQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: UpdateMaintenanceReportDraftCommand,
  ): Promise<MaintenanceReportDraftMutationResult> {
    assertMaintenanceReportAuthorRole(command.session);
    assertMaintenanceReportId(command.reportId);
    // R050-02/R062-01：续填可携带暂存原件；file_id/上下文形态在事务前核验
    const attachment = normalizeStagedAttachment(command.attachment);
    return this.transactionRunner.run((transactionContext) =>
      this.doUpdate(command, attachment, transactionContext),
    );
  }

  private async doUpdate(
    command: UpdateMaintenanceReportDraftCommand,
    attachment: NormalizedStagedAttachment,
    transactionContext: PersistenceTransactionContext,
  ): Promise<MaintenanceReportDraftMutationResult> {
    const lock = await lockEditableReportForAuthor({
      maintenanceReportService: this.maintenanceReportService,
      organizationContextService: this.organizationContextService,
      accountId: command.session.accountId,
      reportId: command.reportId,
      transactionContext,
    });
    // 恢复期写入冻结：报告归属公司数据区正在恢复时不得更新草稿
    await this.localWriteHoldService.assertBusinessWritableInTransaction({
      organizationId: lock.report.ownerOrganizationId,
      transactionContext,
    });
    const existing = await this.maintenanceReportQueryService.readDraftDetail(
      command.reportId,
      transactionContext,
    );
    if (!existing) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在');
    }

    // 2026-11-20 需求调整：工单总结只读核对——客户端不携带内容字段，
    // 保存草稿时以服务端核验的当前工单事实重新派生（重新保存即重新核对）；
    // AI 评价组按库内既有值保留，供任务 05 接通后续填
    if (existing.report.sourceType === MaintenanceReportSourceType.WORK_ORDER_SUMMARY) {
      return this.updateWorkOrderSummaryDraft(command, existing, transactionContext);
    }

    const effective = mergeDraftInput(existing, command.draft);
    const draft = normalizeMaintenanceReportDraft(effective, command.session.accountId, {
      // 只有本次未显式改写帮助程度时，才允许库内历史值（31 态合法的 5）原样保留。
      preservedAiHelpfulness:
        command.draft.aiHelpfulness === undefined ? existing.report.aiHelpfulness : null,
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

    // R050-02/R062-01：内容更新与附件绑定/更换同事务；
    // 绑定或更换任一步失败，随本事务与内容一起回滚，不丢失原有有效关联
    if (attachment !== null) {
      await ensureStagedAttachmentBinding({
        storedFileService: this.storedFileService,
        maintenanceReportService: this.maintenanceReportService,
        maintenanceReportQueryService: this.maintenanceReportQueryService,
        reportId: command.reportId,
        ownerOrganizationId: lock.report.ownerOrganizationId,
        accountId: command.session.accountId,
        attachment,
        mode: 'replace',
        transactionContext,
      });
    }

    await this.maintenanceReportService.updateDraft(command.reportId, draft, transactionContext);
    if (command.draft.alarms !== undefined) {
      await this.maintenanceReportService.replaceAlarms(
        command.reportId,
        draft.alarms,
        transactionContext,
      );
    }
    // 步骤替换会先清理故障行（复合外键 ON DELETE RESTRICT），
    // 因此只要动过步骤，就必须随后重建有效故障分支，不能留下空故障集。
    const stepsReplaced = command.draft.steps !== undefined;
    if (stepsReplaced) {
      await this.maintenanceReportService.replaceSteps(
        command.reportId,
        draft.steps,
        transactionContext,
      );
    }
    if (stepsReplaced || command.draft.faults !== undefined) {
      await this.maintenanceReportService.replaceFaults(
        command.reportId,
        draft.faults,
        transactionContext,
      );
    }

    const saved = await this.maintenanceReportQueryService.readReport(
      command.reportId,
      transactionContext,
    );
    if (!saved) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在');
    }
    return {
      reportId: saved.id,
      status: saved.status,
      currentVersionNo: saved.currentVersionNo,
      updatedAt: saved.updatedAt,
    };
  }

  /**
   * 工单总结草稿更新：内容字段全部来自当前工单事实（重新保存即重新核对）。
   * 客户端补丁不得携带内容字段，也不得为总结挂接报告原件；
   * AI 评价组按库内既有值保留（任务 05 未接通前为 NOT_USED）。
   */
  private async updateWorkOrderSummaryDraft(
    command: UpdateMaintenanceReportDraftCommand,
    existing: MaintenanceReportDraftDetailView,
    transactionContext: PersistenceTransactionContext,
  ): Promise<MaintenanceReportDraftMutationResult> {
    if (command.attachment !== null && command.attachment !== undefined) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
        '工单维修总结不单独登记报告原件，来源工单原件按工单权限读取',
      );
    }
    assertNoWorkOrderSummaryClientContent(command.draft);
    const repairRequestId = existing.report.repairRequestId;
    if (repairRequestId === null) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT, '工单总结缺少关联工单', {
        reportId: command.reportId,
      });
    }
    const workOrder = await this.maintenanceReportService.readRepairRequestWriteContext(
      repairRequestId,
      transactionContext,
    );
    assertWorkOrderSummaryPreconditions({
      request: workOrder,
      repairRequestId,
      accountId: command.session.accountId,
      organizationId: existing.report.ownerOrganizationId,
    });
    const derived = await this.deriveWorkOrderSummaryDraft(
      workOrder as RepairRequestWriteContext,
      command.session.accountId,
      existing,
      command.draft,
      transactionContext,
    );

    await this.maintenanceReportService.updateDraft(command.reportId, derived, transactionContext);
    await this.maintenanceReportService.replaceAlarms(
      command.reportId,
      derived.alarms,
      transactionContext,
    );
    await this.maintenanceReportService.replaceSteps(
      command.reportId,
      derived.steps,
      transactionContext,
    );
    await this.maintenanceReportService.replaceFaults(
      command.reportId,
      derived.faults,
      transactionContext,
    );

    const saved = await this.maintenanceReportQueryService.readReport(
      command.reportId,
      transactionContext,
    );
    if (!saved) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在');
    }
    return {
      reportId: saved.id,
      status: saved.status,
      currentVersionNo: saved.currentVersionNo,
      updatedAt: saved.updatedAt,
    };
  }

  /**
   * 工单事实 → 报告草稿写入数据。
   *
   * AI 评价组按「客户端显式字段优先、未提供沿用库内值」合并；
   * 标记使用 AI 时必须指向本人工单内、所选版本有有效回复的真实会话（任务 05 读侧）。
   */
  private async deriveWorkOrderSummaryDraft(
    workOrder: RepairRequestWriteContext,
    accountId: number,
    existing: MaintenanceReportDraftDetailView,
    aiPatch: MaintenanceReportDraftInput,
    transactionContext: PersistenceTransactionContext,
  ): Promise<ReturnType<typeof normalizeMaintenanceReportDraft>> {
    const facts = await readWorkOrderSummarySourceFacts({
      request: workOrder,
      maintenanceQueryService: this.maintenanceQueryService,
      organizationQueryService: this.organizationQueryService,
      transactionContext,
    });
    const input = buildWorkOrderSummaryDraftInput(facts);
    const ai = resolveWorkOrderSummaryAiEvaluationInput(aiPatch, existing.report);
    input.aiUsage = ai.aiUsage;
    input.aiSourceType = ai.aiSourceType;
    input.aiSourceId = ai.aiSourceId;
    input.aiSourceVersion = ai.aiSourceVersion;
    input.aiScore = ai.aiScore;
    input.aiCorrectness = ai.aiCorrectness;
    input.aiHelpfulness = ai.aiHelpfulness;
    input.aiNote = ai.aiNote;
    const draft = normalizeMaintenanceReportDraft(input, accountId, {
      // 未显式改写帮助程度时允许库内历史值（31 态合法的 5）原样保留
      preservedAiHelpfulness:
        aiPatch.aiHelpfulness === undefined ? existing.report.aiHelpfulness : null,
      // 工单总结派生复用结单侧（任务 04）结单原因规则：非终结结果原因可选
      allowNonTerminalClosureReason: true,
    });
    await assertWorkOrderSummaryAiEvaluationReference({
      ai: {
        aiUsage: draft.aiUsage,
        aiSourceType: draft.aiSourceType,
        aiSourceId: draft.aiSourceId,
        aiSourceVersion: draft.aiSourceVersion,
        aiScore: draft.aiScore,
        aiCorrectness: draft.aiCorrectness,
        aiHelpfulness: draft.aiHelpfulness,
        aiNote: draft.aiNote,
      },
      viewerAccountId: accountId,
      viewerOrganizationId: existing.report.ownerOrganizationId,
      repairRequestId: existing.report.repairRequestId as number,
      aiConversationQueryService: this.aiConversationQueryService,
    });
    return draft;
  }
}

/**
 * 草稿补丁合并：未提供的字段沿用落库值，提供即整体替换。
 *
 * 故障分支在读取时不携带"失效分支"（服务端只存当前有效分支），
 * 显式提供 faults 时整体替换；仅改步骤时由调用方按合并后的 faults 重建。
 */
function mergeDraftInput(
  existing: MaintenanceReportDraftDetailView,
  patch: MaintenanceReportDraftInput,
): MaintenanceReportDraftInput {
  const { report, alarms, steps, faults } = existing;
  const hasAiPatch =
    patch.aiUsage !== undefined ||
    patch.aiSourceType !== undefined ||
    patch.aiSourceId !== undefined ||
    patch.aiSourceVersion !== undefined ||
    patch.aiScore !== undefined ||
    patch.aiCorrectness !== undefined ||
    patch.aiHelpfulness !== undefined ||
    patch.aiNote !== undefined;

  const merged: MaintenanceReportDraftInput = {
    title: patch.title !== undefined ? patch.title : report.title,
    customerFactoryName:
      patch.customerFactoryName !== undefined
        ? patch.customerFactoryName
        : report.customerFactoryName,
    equipmentModelId:
      patch.equipmentModelId !== undefined ? patch.equipmentModelId : report.equipmentModelId,
    equipmentModelText:
      patch.equipmentModelText !== undefined ? patch.equipmentModelText : report.equipmentModelText,
    maintenanceDate:
      patch.maintenanceDate !== undefined ? patch.maintenanceDate : report.maintenanceDate,
    handlingResult:
      patch.handlingResult !== undefined ? patch.handlingResult : report.handlingResult,
    closureReason: patch.closureReason !== undefined ? patch.closureReason : report.closureReason,
    resetResult: patch.resetResult !== undefined ? patch.resetResult : report.resetResult,
    actualCause: patch.actualCause !== undefined ? patch.actualCause : report.actualCause,
    repairActions: patch.repairActions !== undefined ? patch.repairActions : report.repairActions,
    verificationResult:
      patch.verificationResult !== undefined ? patch.verificationResult : report.verificationResult,
    supplementaryNote:
      patch.supplementaryNote !== undefined ? patch.supplementaryNote : report.supplementaryNote,
    alarms: patch.alarms !== undefined ? patch.alarms : alarms.map((alarm) => ({ ...alarm })),
    steps:
      patch.steps !== undefined
        ? patch.steps
        : steps.map((step) => ({
            stepCode: step.stepCode,
            phaseCode: step.phaseCode,
            partName: step.partName,
            actionText: step.actionText,
            resultCode: step.resultCode,
            errorCode: step.errorCode,
            resultText: step.resultText,
            newAlarmCode: step.newAlarmCode,
            isValidNewBranch: step.isValidNewBranch,
          })),
    faults:
      patch.faults !== undefined
        ? patch.faults
        : faults.map((fault) => ({
            branchKind: fault.branchKind,
            stepCode: fault.stepCode,
            phaseCode: fault.phaseCode,
            mainError: fault.mainError,
            unitError: fault.unitError,
            source: fault.source,
            errorType: fault.errorType,
            gpibStatus: fault.gpibStatus,
            faultStatus: fault.faultStatus,
            description: fault.description,
            action: fault.action,
          })),
  };

  if (hasAiPatch) {
    merged.aiUsage = patch.aiUsage !== undefined ? patch.aiUsage : report.aiUsage;
    merged.aiSourceType =
      patch.aiSourceType !== undefined ? patch.aiSourceType : report.aiSourceType;
    merged.aiSourceId = patch.aiSourceId !== undefined ? patch.aiSourceId : report.aiSourceId;
    merged.aiSourceVersion =
      patch.aiSourceVersion !== undefined ? patch.aiSourceVersion : report.aiSourceVersion;
    merged.aiScore = patch.aiScore !== undefined ? patch.aiScore : report.aiScore;
    merged.aiCorrectness =
      patch.aiCorrectness !== undefined ? patch.aiCorrectness : report.aiCorrectness;
    merged.aiHelpfulness =
      patch.aiHelpfulness !== undefined ? patch.aiHelpfulness : report.aiHelpfulness;
    merged.aiNote = patch.aiNote !== undefined ? patch.aiNote : report.aiNote;
  } else {
    merged.aiUsage = report.aiUsage;
    merged.aiSourceType = report.aiSourceType;
    merged.aiSourceId = report.aiSourceId;
    merged.aiSourceVersion = report.aiSourceVersion;
    merged.aiScore = report.aiScore;
    merged.aiCorrectness = report.aiCorrectness;
    merged.aiHelpfulness = report.aiHelpfulness;
    merged.aiNote = report.aiNote;
  }
  return merged;
}
