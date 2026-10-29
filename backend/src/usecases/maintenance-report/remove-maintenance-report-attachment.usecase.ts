// src/usecases/maintenance-report/remove-maintenance-report-attachment.usecase.ts

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
  MaintenanceReportAttachmentMutationResult,
  RemoveMaintenanceReportAttachmentCommand,
} from './maintenance-report-command.types';
import {
  assertMaintenanceReportAuthorRole,
  assertMaintenanceReportId,
} from './maintenance-report-roles';
import { lockEditableReportForAuthor } from './maintenance-report-write-guard';

/**
 * 移除（退役）当前附件：仅本人可编辑状态下可执行。
 *
 * 采用状态退役而非物理删除：已冻结版本通过复合外键仍可回溯历史附件，
 * 退役行不再计入当前集合与大小统计。
 */
@Injectable()
export class RemoveMaintenanceReportAttachmentUsecase {
  constructor(
    private readonly maintenanceReportService: MaintenanceReportService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: RemoveMaintenanceReportAttachmentCommand,
  ): Promise<MaintenanceReportAttachmentMutationResult> {
    assertMaintenanceReportAuthorRole(command.session);
    assertMaintenanceReportId(command.reportId);
    if (!Number.isInteger(command.attachmentId) || command.attachmentId <= 0) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, '附件 ID 无效', {
        attachmentId: command.attachmentId,
      });
    }
    return this.transactionRunner.run(async (transactionContext) => {
      await lockEditableReportForAuthor({
        maintenanceReportService: this.maintenanceReportService,
        organizationContextService: this.organizationContextService,
        accountId: command.session.accountId,
        reportId: command.reportId,
        transactionContext,
      });
      const retired = await this.maintenanceReportService.retireAttachment(
        command.reportId,
        command.attachmentId,
        new Date(),
        transactionContext,
      );
      if (!retired) {
        throw new DomainError(MAINTENANCE_REPORT_ERROR.ATTACHMENT_NOT_FOUND, '附件不存在或已移除', {
          attachmentId: command.attachmentId,
        });
      }
      const current = await this.maintenanceReportQueryService.readCurrentAttachmentsForSubmit(
        command.reportId,
        transactionContext,
      );
      return {
        reportId: command.reportId,
        attachmentIds: current.map((item) => item.id),
        currentBytes: current.reduce((total, item) => total + item.byteSize, 0),
      };
    });
  }
}
