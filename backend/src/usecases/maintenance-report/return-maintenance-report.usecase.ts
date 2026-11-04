// src/usecases/maintenance-report/return-maintenance-report.usecase.ts

import { MaintenanceReportReviewDecision } from '@app-types/models/maintenance-report.types';
import { Inject, Injectable } from '@nestjs/common';
import { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import type {
  MaintenanceReportReviewResult,
  ReviewMaintenanceReportCommand,
} from './maintenance-report-command.types';
import { lockReviewableReport, requireReviewComment } from './maintenance-report-review.helpers';
import {
  assertMaintenanceReportId,
  assertMaintenanceReportReviewRole,
} from './maintenance-report-roles';

/**
 * 退回维修报告：仅同组织管理员对 PENDING_REVIEW 报告执行；退回原因必填。
 * 审核记录与状态变更同事务，退回后报告回到作者可编辑态。
 */
@Injectable()
export class ReturnMaintenanceReportUsecase {
  constructor(
    private readonly maintenanceReportService: MaintenanceReportService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: ReviewMaintenanceReportCommand): Promise<MaintenanceReportReviewResult> {
    assertMaintenanceReportReviewRole(command.session);
    assertMaintenanceReportId(command.reportId);
    const comment = requireReviewComment(command.comment);
    return this.transactionRunner.run(async (transactionContext) => {
      const reviewable = await lockReviewableReport({
        maintenanceReportService: this.maintenanceReportService,
        maintenanceReportQueryService: this.maintenanceReportQueryService,
        organizationContextService: this.organizationContextService,
        accountId: command.session.accountId,
        reportId: command.reportId,
        transactionContext,
      });
      const reviewedAt = new Date();
      const review = await this.maintenanceReportService.insertReview(
        {
          reportId: command.reportId,
          versionId: reviewable.version.id,
          decision: MaintenanceReportReviewDecision.RETURN,
          comment,
          reviewedByAccountId: command.session.accountId,
          reviewedAt,
        },
        transactionContext,
      );
      await this.maintenanceReportService.markReturned(
        command.reportId,
        reviewedAt,
        command.session.accountId,
        transactionContext,
      );
      return {
        reportId: command.reportId,
        reviewId: review.id,
        decision: review.decision,
        status: 'RETURNED',
        reviewedAt,
      };
    });
  }
}
