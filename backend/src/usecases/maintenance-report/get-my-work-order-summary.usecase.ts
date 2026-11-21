// src/usecases/maintenance-report/get-my-work-order-summary.usecase.ts

import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import type {
  WorkOrderSummaryEntryView,
  WorkOrderSummarySourcePreviewView,
} from '@src/modules/lithography/maintenance-report.types';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { RepairRequestMaintenanceQueryService } from '@src/modules/lithography/queries/repair-request-maintenance.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { GetMyWorkOrderSummaryCommand } from './maintenance-report-command.types';
import { normalizeMaintenanceReportDraft } from './maintenance-report.input.normalize';
import {
  assertMaintenanceReportAuthorRole,
  assertMaintenanceReportId,
} from './maintenance-report-roles';
import { isWorkOrderClosed } from './maintenance-report-work-order.constants';
import {
  buildWorkOrderSummaryDraftInput,
  buildWorkOrderSummaryFrozenPreview,
  buildWorkOrderSummarySourcePreview,
  fingerprintWorkOrderSummarySource,
  isSameWorkOrderSummaryDraftContent,
  readFrozenSourceConfirmationFingerprint,
  readWorkOrderSummarySourceFacts,
  type WorkOrderSummarySourceFacts,
} from './maintenance-report-work-order-source.helpers';

/**
 * 工单维修总结入口读取：本人已接单且已结单的工单，返回同一份草稿（若有）。
 *
 * - 归属与结单事实全部来自服务端可信会话与工单行，不接受客户端自报作者/公司；
 * - 他人或跨组织工单统一 NOT_FOUND，不泄露存在性；未结单返回业务冲突；
 * - 本用例只读，不创建报告（打开页面不得自动建草稿）；
 * - 2026-11-20 需求调整：附带给出来源工单相对草稿是否已被修订的判定，
 *   供页面提示"重新核对后重新保存"，不静默覆盖草稿或悄悄提交旧数据。
 */
@Injectable()
export class GetMyWorkOrderSummaryUsecase {
  constructor(
    private readonly maintenanceReportService: MaintenanceReportService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    private readonly maintenanceQueryService: RepairRequestMaintenanceQueryService,
    private readonly organizationQueryService: OrganizationQueryService,
  ) {}

  async execute(command: GetMyWorkOrderSummaryCommand): Promise<WorkOrderSummaryEntryView> {
    assertMaintenanceReportAuthorRole(command.session);
    assertMaintenanceReportId(command.repairRequestId);

    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
    });
    const workOrder = await this.maintenanceReportService.findRepairRequestWriteContext(
      command.repairRequestId,
    );
    if (workOrder === null || workOrder.deprecated) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '工单不存在或已撤回', {
        repairRequestId: command.repairRequestId,
      });
    }
    if (
      !workOrder.isAccepted ||
      workOrder.acceptedEngineerAccountId !== command.session.accountId ||
      workOrder.ownerOrganizationId !== membership.organizationId
    ) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '工单不存在或不可访问', {
        repairRequestId: command.repairRequestId,
      });
    }
    if (!isWorkOrderClosed(workOrder.closureStatus)) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.WORK_ORDER_NOT_CLOSED,
        '工单尚未结单，不能填写维修总结',
        { repairRequestId: command.repairRequestId },
      );
    }

    const model = await this.maintenanceReportQueryService.findEquipmentModelRef(
      workOrder.equipmentModelId,
    );

    const ownership = await this.maintenanceReportQueryService.findOwnershipByRepairRequestId(
      command.repairRequestId,
    );
    if (ownership === null) {
      const sourceFacts = await readWorkOrderSummarySourceFacts({
        request: workOrder,
        maintenanceQueryService: this.maintenanceQueryService,
        organizationQueryService: this.organizationQueryService,
      });
      return {
        ...this.entryFactsFromCurrentFacts({
          workOrder,
          model,
          sourceFacts,
          repairRequestId: command.repairRequestId,
        }),
        report: null,
        sourceChangedSinceDraft: false,
      };
    }
    if (
      ownership.maintenanceEngineerAccountId !== command.session.accountId ||
      ownership.ownerOrganizationId !== membership.organizationId
    ) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在或不可访问', {
        repairRequestId: command.repairRequestId,
      });
    }
    const report = await this.maintenanceReportQueryService.readReportDetail(
      ownership.reportId,
      undefined,
      {
        ownerOrganizationId: membership.organizationId,
        maintenanceEngineerAccountId: command.session.accountId,
      },
    );

    // 2026-11-21 冻结读取：已正式提交的总结（canEdit=false）不再从当前工单
    // 拼装预览——页面展示与提交校验标识全部来自冻结版本 payload（与 Word/PDF
    // 导出同源）；可编辑草稿/无报告仍读取当前工单（提交前的只读核对口径）。
    if (report !== null && report.canEdit === false) {
      const frozenVersion = report.currentVersion;
      if (frozenVersion === null) {
        throw new DomainError(
          MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT,
          '已提交总结缺少冻结版本，无法按冻结内容读取',
          { reportId: report.report.id },
        );
      }
      const payload = frozenVersion.payloadSnapshot;
      return {
        ...this.entryFactsFromFrozenPayload({
          workOrder,
          model,
          payload,
          reportId: report.report.id,
          repairRequestId: command.repairRequestId,
        }),
        report,
        sourceChangedSinceDraft: false,
      };
    }

    const sourceFacts = await readWorkOrderSummarySourceFacts({
      request: workOrder,
      maintenanceQueryService: this.maintenanceQueryService,
      organizationQueryService: this.organizationQueryService,
    });
    const sourceChangedSinceDraft =
      report !== null && report.canEdit
        ? await this.resolveSourceChangedSinceDraft(workOrder, report)
        : false;
    return {
      ...this.entryFactsFromCurrentFacts({
        workOrder,
        model,
        sourceFacts,
        repairRequestId: command.repairRequestId,
      }),
      report,
      sourceChangedSinceDraft,
    };
  }

  /** 入口公共事实 + 当前工单派生的预览与指纹（提交前核对口径） */
  private entryFactsFromCurrentFacts(params: {
    workOrder: NonNullable<
      Awaited<ReturnType<MaintenanceReportService['findRepairRequestWriteContext']>>
    >;
    model: { id: number; modelCode: string; modelName: string } | null;
    sourceFacts: WorkOrderSummarySourceFacts;
    repairRequestId: number;
  }): {
    sourceConfirmation: string;
    sourcePreview: WorkOrderSummarySourcePreviewView;
    repairRequestId: number;
    requestNo: string;
    equipmentModelId: number;
    equipmentModelCode: string | null;
    equipmentModelName: string | null;
    closedAt: Date | null;
  } {
    const { workOrder, model, sourceFacts } = params;
    return {
      sourceConfirmation: fingerprintWorkOrderSummarySource(sourceFacts),
      sourcePreview: buildWorkOrderSummarySourcePreview(sourceFacts),
      repairRequestId: params.repairRequestId,
      requestNo: workOrder.requestNo,
      equipmentModelId: workOrder.equipmentModelId,
      equipmentModelCode: model?.modelCode ?? null,
      equipmentModelName: model?.modelName ?? null,
      closedAt: workOrder.closedAt,
    };
  }

  /** 入口公共事实 + 冻结版本派生的预览与指纹（已提交总结冻结读取口径） */
  private entryFactsFromFrozenPayload(params: {
    workOrder: NonNullable<
      Awaited<ReturnType<MaintenanceReportService['findRepairRequestWriteContext']>>
    >;
    model: { id: number; modelCode: string; modelName: string } | null;
    payload: Record<string, unknown>;
    reportId: number;
    repairRequestId: number;
  }): {
    sourceConfirmation: string;
    sourcePreview: WorkOrderSummarySourcePreviewView;
    repairRequestId: number;
    requestNo: string;
    equipmentModelId: number;
    equipmentModelCode: string | null;
    equipmentModelName: string | null;
    closedAt: Date | null;
  } {
    const { workOrder, model, payload } = params;
    return {
      sourceConfirmation: readFrozenSourceConfirmationFingerprint(payload, params.reportId),
      sourcePreview: buildWorkOrderSummaryFrozenPreview(payload, params.reportId),
      repairRequestId: params.repairRequestId,
      requestNo: workOrder.requestNo,
      equipmentModelId: workOrder.equipmentModelId,
      equipmentModelCode: model?.modelCode ?? null,
      equipmentModelName: model?.modelName ?? null,
      closedAt: workOrder.closedAt,
    };
  }

  /** 只读派生当前工单事实并与库内可编辑草稿比对；不一致 = 草稿保存后工单已被修订 */
  private async resolveSourceChangedSinceDraft(
    workOrder: NonNullable<
      Awaited<ReturnType<MaintenanceReportService['findRepairRequestWriteContext']>>
    >,
    report: NonNullable<Awaited<ReturnType<MaintenanceReportQueryService['readReportDetail']>>>,
  ): Promise<boolean> {
    const facts = await readWorkOrderSummarySourceFacts({
      request: workOrder,
      maintenanceQueryService: this.maintenanceQueryService,
      organizationQueryService: this.organizationQueryService,
    });
    const input = buildWorkOrderSummaryDraftInput(facts);
    input.aiUsage = report.report.aiUsage;
    input.aiSourceType = report.report.aiSourceType;
    input.aiSourceId = report.report.aiSourceId;
    input.aiSourceVersion = report.report.aiSourceVersion;
    input.aiScore = report.report.aiScore;
    input.aiCorrectness = report.report.aiCorrectness;
    input.aiHelpfulness = report.report.aiHelpfulness;
    input.aiNote = report.report.aiNote;
    const derived = normalizeMaintenanceReportDraft(input, report.report.updatedByAccountId, {
      // 工单总结派生复用结单侧（任务 04）结单原因规则：非终结结果原因可选
      allowNonTerminalClosureReason: true,
    });
    const stored = await this.maintenanceReportQueryService.readDraftDetail(report.report.id);
    if (stored === null) return false;
    return !isSameWorkOrderSummaryDraftContent(stored, derived);
  }
}
