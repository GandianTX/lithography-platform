// src/usecases/maintenance-report/add-maintenance-report-attachment.usecase.ts
//
// R050-02 / R045-02 追加挂接：为本人可编辑报告登记并绑定一个任务 11 暂存原件。
//
// 绑定事务段与首存（R050-01/R045-02）、首次直接提交（R051-01）共用
// maintenance-report-attachment-binding.helpers，保证 file_id 落库与
// 暂存事实核验口径在所有写入入口一致：

import { MaintenanceReportSourceType } from '@app-types/models/maintenance-report.types';
import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import { StoredFileService } from '@src/modules/lithography/stored-file.service';
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
import { ensureStagedAttachmentBinding } from './maintenance-report-attachment-binding.helpers';
import { trimRequiredText } from './maintenance-report.input.normalize';
import {
  assertMaintenanceReportAuthorRole,
  assertMaintenanceReportId,
} from './maintenance-report-roles';
import { lockEditableReportForAuthor } from './maintenance-report-write-guard';

/**
 * 登记并绑定一个任务 11 暂存原件到本人可编辑报告（R050-02 / R045-02 口径）。
 *
 * 同一事务内完成：
 * 1. 报告行锁 + 归属/可编辑裁决（复用作者写守卫）；
 * 2. 暂存事实核验 + 原子绑定 + 附件行登记（含 file_id，见共享绑定助手）。
 *
 * 任一事实不成立或绑定未命中即整体回滚：不留半份附件关联，也不占用暂存原件。
 * 暂存原件在失败后保持 TEMPORARY 可追踪，不做物理清理。
 */
@Injectable()
export class AddMaintenanceReportAttachmentUsecase {
  constructor(
    private readonly maintenanceReportService: MaintenanceReportService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly storedFileService: StoredFileService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    private readonly localWriteHoldService: LocalWriteHoldService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: AddMaintenanceReportAttachmentCommand,
  ): Promise<MaintenanceReportAttachmentMutationResult> {
    assertMaintenanceReportAuthorRole(command.session);
    assertMaintenanceReportId(command.reportId);
    const fileId = requireFileId(command.fileId);
    const uploadContextId = requireFileId(command.uploadContextId, '上传上下文');
    return this.transactionRunner.run(async (transactionContext) => {
      const lock = await lockEditableReportForAuthor({
        maintenanceReportService: this.maintenanceReportService,
        organizationContextService: this.organizationContextService,
        accountId: command.session.accountId,
        reportId: command.reportId,
        transactionContext,
      });
      // 恢复期写入冻结：报告归属公司数据区正在恢复时不得挂接附件
      await this.localWriteHoldService.assertBusinessWritableInTransaction({
        organizationId: lock.report.ownerOrganizationId,
        transactionContext,
      });
      // 2026-11-20 需求调整：工单总结不单独登记报告原件——来源工单原件归属工单，
      // 总结页只读展示并按工单权限下载；不复制文件、不改 stored_file 业务归属
      if (lock.report.sourceType === MaintenanceReportSourceType.WORK_ORDER_SUMMARY) {
        throw new DomainError(
          MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
          '工单维修总结不单独登记报告原件，来源工单原件按工单权限读取',
        );
      }
      await ensureStagedAttachmentBinding({
        storedFileService: this.storedFileService,
        maintenanceReportService: this.maintenanceReportService,
        maintenanceReportQueryService: this.maintenanceReportQueryService,
        reportId: command.reportId,
        ownerOrganizationId: lock.report.ownerOrganizationId,
        accountId: command.session.accountId,
        attachment: { fileId, uploadContextId, description: command.description ?? null },
        mode: 'append',
        requestedSortOrder: command.sortOrder ?? null,
        transactionContext,
      });
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

/** fileId / uploadContextId 都是 char(36) 稳定标识：缺省或空白直接拒绝，不进入行锁 */
function requireFileId(value: string, label = '原件编号'): string {
  const trimmed = trimRequiredText(value);
  if (trimmed.length === 0) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, `${label}缺失`, {
      fileId: value,
    });
  }
  return trimmed;
}
