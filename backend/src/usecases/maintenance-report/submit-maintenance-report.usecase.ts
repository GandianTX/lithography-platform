// src/usecases/maintenance-report/submit-maintenance-report.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  MaintenanceAiUsage,
  MaintenanceReportChangeKind,
} from '@app-types/models/maintenance-report.types';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import type {
  MaintenanceReportSubmitResult,
  SubmitMaintenanceReportCommand,
} from './maintenance-report-command.types';
import { assertGeneratedAnalysisOutput } from './maintenance-report.input.normalize';
import {
  assertMaintenanceReportAuthorRole,
  assertMaintenanceReportId,
} from './maintenance-report-roles';
import {
  assertMaintenanceReportSubmittable,
  buildMaintenanceReportSnapshotPayload,
} from './maintenance-report-snapshot';
import { lockEditableReportForAuthor } from './maintenance-report-write-guard';
import {
  ANALYSIS_OUTPUT_READER,
  type AnalysisOutputReader,
} from './ports/analysis-output-reader.contract';

/** 事务外解析得到、等待行锁后复核的分析结果引用三元组 */
type AnalysisReference = {
  aiUsage: MaintenanceAiUsage;
  aiSourceType: string | null;
  aiSourceId: string | null;
  aiSourceVersion: string | null;
};

/**
 * 提交维修报告：冻结当前工作态为不可变版本并进入待审核。
 *
 * 顺序：
 * 1. 事务外：只读报告并解析「已使用 AI」引用的分析结果（read + 校验，写入前失败关闭）
 * 2. 事务内：报告行锁必须作为首次读取（锁定读），随后解析组织、裁决本人/同组织/可编辑状态
 * 3. 复核锁后报告的分析结果引用三元组与事务外解析值一致，被并发修改则 CONFLICT 重试
 * 4. 基于锁后真实事实校验（标题/厂家/日期/步骤上限/AI 引用三元组）并冻结 v2 快照
 * 5. 版本附件 → 状态置 PENDING_REVIEW
 *
 * 外部分析结果读取不放在事务与行锁内：读取器是外部系统，锁内远程调用会拉长持锁时间。
 * 外部分析结果读取失败一律抛错终止：正式环境未接入时不可用，绝不降级为成功。
 */
@Injectable()
export class SubmitMaintenanceReportUsecase {
  constructor(
    private readonly maintenanceReportService: MaintenanceReportService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(ANALYSIS_OUTPUT_READER)
    private readonly analysisOutputReader: AnalysisOutputReader,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: SubmitMaintenanceReportCommand): Promise<MaintenanceReportSubmitResult> {
    assertMaintenanceReportAuthorRole(command.session);
    assertMaintenanceReportId(command.reportId);
    const analysisReference = await this.prepareAnalysisOutput(
      command.reportId,
      command.session.accountId,
    );
    return this.transactionRunner.run((transactionContext) =>
      this.doSubmit(command, analysisReference, transactionContext),
    );
  }

  private async doSubmit(
    command: SubmitMaintenanceReportCommand,
    analysisReference: AnalysisReference,
    transactionContext: PersistenceTransactionContext,
  ): Promise<MaintenanceReportSubmitResult> {
    const lock = await lockEditableReportForAuthor({
      maintenanceReportService: this.maintenanceReportService,
      organizationContextService: this.organizationContextService,
      accountId: command.session.accountId,
      reportId: command.reportId,
      transactionContext,
    });
    const draft = await this.maintenanceReportQueryService.readDraftDetail(
      command.reportId,
      transactionContext,
    );
    if (!draft) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在');
    }

    // 附件集合读取必须先于任何普通读之前完成行锁（lockEditableReportForAuthor 已保证），
    // 因此此处普通读落在锁后读视图上，冻结内容可复现
    const currentAttachments =
      await this.maintenanceReportQueryService.readCurrentAttachmentsForSubmit(
        command.reportId,
        transactionContext,
      );
    const submitDraft = { ...draft, attachments: currentAttachments };
    assertMaintenanceReportSubmittable(submitDraft);

    assertAnalysisReferenceUnchanged(analysisReference, lock.report);
    const payload = buildMaintenanceReportSnapshotPayload(submitDraft);
    const versionNo = lock.report.currentVersionNo + 1;
    const submittedAt = new Date();

    const version = await this.maintenanceReportService.insertVersion(
      {
        reportId: command.reportId,
        versionNo,
        changeKind: MaintenanceReportChangeKind.SUBMIT,
        changeReason: null,
        payloadSnapshot: payload,
        submittedByAccountId: command.session.accountId,
        submittedAt,
      },
      transactionContext,
    );
    await this.maintenanceReportService.insertVersionAttachments(
      version.id,
      command.reportId,
      currentAttachments.map((attachment) => ({
        attachmentId: attachment.id,
        sortOrder: attachment.sortOrder,
        descriptionSnapshot: attachment.description,
      })),
      transactionContext,
    );
    await this.maintenanceReportService.markPendingReview(
      command.reportId,
      versionNo,
      submittedAt,
      command.session.accountId,
      transactionContext,
    );

    return {
      reportId: command.reportId,
      versionId: version.id,
      versionNo,
      status: 'PENDING_REVIEW',
    };
  }

  /**
   * 事务外解析：只读报告事实，并在「已使用 AI」时读取校验外部分析结果。
   *
   * 归属预检必须先于外部分析结果读取：非本人报告一律按不存在处理，
   * 既避免向非作者暴露他人报告的分析结果引用，也避免外部读取被用作元数据探测。
   * 读取器不可用/未找到/未成功/跨组织/工单不符均在此失败关闭，绝不降级为成功。
   */
  private async prepareAnalysisOutput(
    reportId: number,
    accountId: number,
  ): Promise<AnalysisReference> {
    const report = await this.maintenanceReportQueryService.readReport(reportId);
    if (!report) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在');
    }
    if (report.maintenanceEngineerAccountId !== accountId) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在或不可访问');
    }
    await this.resolveAnalysisOutput(report);
    return {
      aiUsage: report.aiUsage,
      aiSourceType: report.aiSourceType,
      aiSourceId: report.aiSourceId,
      aiSourceVersion: report.aiSourceVersion,
    };
  }

  /**
   * 读取并校验「已使用 AI」引用的分析结果；未标记使用时直接返回。
   * 只校验引用可读且事实一致，调用方不得据此把分析正文写入冻结快照。
   */
  private async resolveAnalysisOutput(report: {
    ownerOrganizationId: number;
    repairRequestId: number | null;
    aiUsage: MaintenanceAiUsage;
    aiSourceType: string | null;
    aiSourceId: string | null;
    aiSourceVersion: string | null;
  }): Promise<void> {
    if (report.aiUsage !== MaintenanceAiUsage.USED) return;
    if (!report.aiSourceType || !report.aiSourceId || !report.aiSourceVersion) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_REFERENCE_REQUIRED,
        '已使用 AI 时必须提供分析结果来源、稳定标识与不可变版本',
      );
    }
    const output = await this.analysisOutputReader.read({
      sourceType: report.aiSourceType,
      sourceId: report.aiSourceId,
      sourceVersion: report.aiSourceVersion,
    });
    if (output === null) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_NOT_FOUND,
        '分析结果不存在或版本不可读',
        { sourceId: report.aiSourceId, sourceVersion: report.aiSourceVersion },
      );
    }
    if (
      output.sourceType !== report.aiSourceType ||
      output.sourceId !== report.aiSourceId ||
      output.sourceVersion !== report.aiSourceVersion
    ) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_NOT_FOUND,
        '分析结果来源与引用不一致',
      );
    }
    assertGeneratedAnalysisOutput(output, {
      ownerOrganizationId: report.ownerOrganizationId,
      repairRequestId: report.repairRequestId,
    });
  }
}

/**
 * 冻结前复核：事务外解析得到的引用三元组必须与行锁后的报告事实一致。
 * 不一致说明并发改动了引用，写入会冻结与校验事实不符的内容，故要求重试。
 */
function assertAnalysisReferenceUnchanged(
  reference: AnalysisReference,
  report: {
    id: number;
    aiUsage: MaintenanceAiUsage;
    aiSourceType: string | null;
    aiSourceId: string | null;
    aiSourceVersion: string | null;
  },
): void {
  if (
    reference.aiUsage !== report.aiUsage ||
    reference.aiSourceType !== report.aiSourceType ||
    reference.aiSourceId !== report.aiSourceId ||
    reference.aiSourceVersion !== report.aiSourceVersion
  ) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.ANALYSIS_OUTPUT_REFERENCE_CHANGED,
      '分析结果引用已变更，请重新提交',
      { reportId: report.id },
    );
  }
}
