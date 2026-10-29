// src/usecases/maintenance-report/update-maintenance-report-draft.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { MAINTENANCE_REPORT_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import type {
  MaintenanceReportAlarmInput,
  MaintenanceReportDraftInput,
  MaintenanceReportDraftMutationResult,
  MaintenanceReportStepInput,
  UpdateMaintenanceReportDraftCommand,
} from './maintenance-report-command.types';
import { normalizeMaintenanceReportDraft } from './maintenance-report.input.normalize';
import {
  assertMaintenanceReportAuthorRole,
  assertMaintenanceReportId,
} from './maintenance-report-roles';
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
    private readonly equipmentModelQueryService: EquipmentModelQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: UpdateMaintenanceReportDraftCommand,
  ): Promise<MaintenanceReportDraftMutationResult> {
    assertMaintenanceReportAuthorRole(command.session);
    assertMaintenanceReportId(command.reportId);
    return this.transactionRunner.run((transactionContext) =>
      this.doUpdate(command, transactionContext),
    );
  }

  private async doUpdate(
    command: UpdateMaintenanceReportDraftCommand,
    transactionContext: PersistenceTransactionContext,
  ): Promise<MaintenanceReportDraftMutationResult> {
    await lockEditableReportForAuthor({
      maintenanceReportService: this.maintenanceReportService,
      organizationContextService: this.organizationContextService,
      accountId: command.session.accountId,
      reportId: command.reportId,
      transactionContext,
    });
    const existing = await this.maintenanceReportQueryService.readDraftDetail(
      command.reportId,
      transactionContext,
    );
    if (!existing) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在');
    }

    const effective = mergeDraftInput(
      existing.report,
      existing.alarms,
      existing.steps,
      command.draft,
    );
    const draft = normalizeMaintenanceReportDraft(effective, command.session.accountId);

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

    await this.maintenanceReportService.updateDraft(command.reportId, draft, transactionContext);
    if (command.draft.alarms !== undefined) {
      await this.maintenanceReportService.replaceAlarms(
        command.reportId,
        draft.alarms,
        transactionContext,
      );
    }
    if (command.draft.steps !== undefined) {
      await this.maintenanceReportService.replaceSteps(
        command.reportId,
        draft.steps,
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
}

function mergeDraftInput(
  report: {
    title: string | null;
    customerFactoryName: string | null;
    equipmentModelId: number | null;
    equipmentModelText: string | null;
    maintenanceDate: string | null;
    aiUsage: string;
    aiSourceType: string | null;
    aiSourceId: string | null;
    aiSourceVersion: string | null;
    aiScore: number | null;
    aiCorrectness: string | null;
    aiHelpfulness: number | null;
    aiNote: string | null;
  },
  alarms: Array<{
    alarmIndex: number;
    alarmCode: string;
    alarmDescription: string | null;
    phaseCode: string;
    resetResult: string;
  }>,
  steps: Array<{
    stepCode: string;
    phaseCode: string;
    partName: string | null;
    actionText: string;
    resultText: string | null;
    newAlarmCode: string | null;
    isValidNewBranch: boolean;
  }>,
  patch: MaintenanceReportDraftInput,
): MaintenanceReportDraftInput {
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
    alarms: patch.alarms !== undefined ? patch.alarms : alarms.map((alarm) => toAlarmInput(alarm)),
    steps: patch.steps !== undefined ? patch.steps : steps.map((step) => toStepInput(step)),
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

function toAlarmInput(alarm: {
  alarmIndex: number;
  alarmCode: string;
  alarmDescription: string | null;
  phaseCode: string;
  resetResult: string;
}): MaintenanceReportAlarmInput {
  return { ...alarm };
}

function toStepInput(step: {
  stepCode: string;
  phaseCode: string;
  partName: string | null;
  actionText: string;
  resultText: string | null;
  newAlarmCode: string | null;
  isValidNewBranch: boolean;
}): MaintenanceReportStepInput {
  return { ...step };
}
