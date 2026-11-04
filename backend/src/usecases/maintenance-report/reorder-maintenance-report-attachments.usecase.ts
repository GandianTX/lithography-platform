// src/usecases/maintenance-report/reorder-maintenance-report-attachments.usecase.ts

import { Inject, Injectable } from '@nestjs/common';
import { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import type {
  MaintenanceReportAttachmentMutationResult,
  ReorderMaintenanceReportAttachmentsCommand,
} from './maintenance-report-command.types';
import { assertExactPermutation } from './reorder-maintenance-report-attachments.input.normalize';
import {
  assertMaintenanceReportAuthorRole,
  assertMaintenanceReportId,
} from './maintenance-report-roles';
import { lockEditableReportForAuthor } from './maintenance-report-write-guard';

/**
 * 重排当前附件：请求必须是当前集合的完整排列（不允许多、少、重复或不存在的 ID）。
 *
 * 排序槽位受 `(report_id, active_sort_order)` 唯一约束；服务层在事务内两段式
 * 释放再占用，避免交换过程中撞唯一键。
 */
@Injectable()
export class ReorderMaintenanceReportAttachmentsUsecase {
  constructor(
    private readonly maintenanceReportService: MaintenanceReportService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: ReorderMaintenanceReportAttachmentsCommand,
  ): Promise<MaintenanceReportAttachmentMutationResult> {
    assertMaintenanceReportAuthorRole(command.session);
    assertMaintenanceReportId(command.reportId);
    return this.transactionRunner.run(async (transactionContext) => {
      await lockEditableReportForAuthor({
        maintenanceReportService: this.maintenanceReportService,
        organizationContextService: this.organizationContextService,
        accountId: command.session.accountId,
        reportId: command.reportId,
        transactionContext,
      });
      const current = await this.maintenanceReportQueryService.readCurrentAttachmentsForSubmit(
        command.reportId,
        transactionContext,
      );
      assertExactPermutation(
        command.orderedAttachmentIds,
        current.map((item) => item.id),
      );
      await this.maintenanceReportService.reorderCurrentAttachments(
        command.reportId,
        command.orderedAttachmentIds,
        transactionContext,
      );
      const after = await this.maintenanceReportQueryService.readCurrentAttachmentsForSubmit(
        command.reportId,
        transactionContext,
      );
      return {
        reportId: command.reportId,
        attachmentIds: after.map((item) => item.id),
        currentBytes: after.reduce((total, item) => total + item.byteSize, 0),
      };
    });
  }
}
