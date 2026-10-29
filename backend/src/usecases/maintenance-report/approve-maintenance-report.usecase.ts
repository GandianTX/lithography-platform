// src/usecases/maintenance-report/approve-maintenance-report.usecase.ts

import { MaintenanceReportReviewDecision } from '@app-types/models/maintenance-report.types';
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
  ApproveMaintenanceReportCommand,
  MaintenanceReportReviewResult,
} from './maintenance-report-command.types';
import { lockReviewableReport, normalizeReviewComment } from './maintenance-report-review.helpers';
import { normalizePublishAttachmentIds } from './maintenance-report-review.input.normalize';
import {
  assertMaintenanceReportId,
  assertMaintenanceReportReviewRole,
} from './maintenance-report-roles';

/**
 * 通过维修报告：仅同组织管理员对 PENDING_REVIEW 报告执行。
 *
 * 发布范围（附件）裁决（设计 §7.5「审核明确选择发布的附件」）：
 * - 版本无附件时，发布选择必须为空；
 * - 版本有附件时，必须显式选择至少一个且全部属于该版本（服务层再按冻结清单复核）。
 * 该解释消除「纯文字总结无附件可发布」与「至少 1 条」的冲突，且不放宽放行条件。
 */
@Injectable()
export class ApproveMaintenanceReportUsecase {
  constructor(
    private readonly maintenanceReportService: MaintenanceReportService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: ApproveMaintenanceReportCommand): Promise<MaintenanceReportReviewResult> {
    assertMaintenanceReportReviewRole(command.session);
    assertMaintenanceReportId(command.reportId);
    const comment = normalizeReviewComment(command.comment);
    const publishedAttachmentIds = normalizePublishAttachmentIds(command.publishedAttachmentIds);

    return this.transactionRunner.run(async (transactionContext) => {
      const reviewable = await lockReviewableReport({
        maintenanceReportService: this.maintenanceReportService,
        maintenanceReportQueryService: this.maintenanceReportQueryService,
        organizationContextService: this.organizationContextService,
        accountId: command.session.accountId,
        reportId: command.reportId,
        transactionContext,
      });
      const versionAttachments = await this.maintenanceReportQueryService.readVersionAttachments(
        reviewable.version.id,
        command.reportId,
        transactionContext,
      );
      if (versionAttachments.length === 0) {
        if (publishedAttachmentIds.length > 0) {
          throw new DomainError(
            MAINTENANCE_REPORT_ERROR.ATTACHMENT_NOT_FOUND,
            '所选附件不属于该冻结版本',
          );
        }
      } else if (publishedAttachmentIds.length === 0) {
        throw new DomainError(
          MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
          '该版本存在附件，审核通过时必须选择至少一个发布附件',
        );
      }

      const reviewedAt = new Date();
      const review = await this.maintenanceReportService.insertReview(
        {
          reportId: command.reportId,
          versionId: reviewable.version.id,
          decision: MaintenanceReportReviewDecision.APPROVE,
          comment,
          reviewedByAccountId: command.session.accountId,
          reviewedAt,
        },
        transactionContext,
      );
      await this.maintenanceReportService.publishVersionAttachments(
        reviewable.version.id,
        command.reportId,
        publishedAttachmentIds,
        transactionContext,
      );
      await this.maintenanceReportService.markApproved(
        command.reportId,
        reviewedAt,
        command.session.accountId,
        transactionContext,
      );
      return {
        reportId: command.reportId,
        reviewId: review.id,
        decision: review.decision,
        status: 'APPROVED',
        reviewedAt,
      };
    });
  }
}
