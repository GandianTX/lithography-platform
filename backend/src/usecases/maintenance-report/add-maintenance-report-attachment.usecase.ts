// src/usecases/maintenance-report/add-maintenance-report-attachment.usecase.ts

import { Inject, Injectable } from '@nestjs/common';
import { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import type {
  AddMaintenanceReportAttachmentCommand,
  MaintenanceReportAttachmentMutationResult,
} from './maintenance-report-command.types';
import { validateAttachmentInput } from './maintenance-report-attachments.helpers';
import {
  assertMaintenanceReportAuthorRole,
  assertMaintenanceReportId,
} from './maintenance-report-roles';
import { lockEditableReportForAuthor } from './maintenance-report-write-guard';

/**
 * 登记一个已落盘的报告附件。
 *
 * 文件实体由上传适配层写入本地存储后，把真实存储引用与元数据交给本用例；
 * 本层不生成占位文件、不接受客户端自报大小以外的内容事实（大小仍按上限校验）。
 * 当前附件集合在报告行锁后以锁定读取得，数量/总字节/排序槽位一并裁决。
 */
@Injectable()
export class AddMaintenanceReportAttachmentUsecase {
  constructor(
    private readonly maintenanceReportService: MaintenanceReportService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: AddMaintenanceReportAttachmentCommand,
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
      const validated = validateAttachmentInput(command.file, current);
      await this.maintenanceReportService.insertAttachment(
        {
          reportId: command.reportId,
          originalFilename: validated.originalFilename,
          mimeType: validated.mimeType,
          byteSize: validated.byteSize,
          checksumSha256: validated.checksumSha256,
          storageBackend: validated.storageBackend,
          storageReference: validated.storageReference,
          sortOrder: validated.sortOrder,
          description: validated.description,
          uploadedByAccountId: command.session.accountId,
        },
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
