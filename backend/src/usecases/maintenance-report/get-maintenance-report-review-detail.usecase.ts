// src/usecases/maintenance-report/get-maintenance-report-review-detail.usecase.ts

import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import type { MaintenanceReportDetailView } from '@src/modules/lithography/maintenance-report.types';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { GetMaintenanceReportCommand } from './maintenance-report-command.types';
import {
  assertMaintenanceReportId,
  assertMaintenanceReportReviewRole,
} from './maintenance-report-roles';

/**
 * 审核详情：仅同组织管理员。
 *
 * 返回报告工作态内容与当前冻结版本（附件、审核记录、历史审核），
 * 供管理员对 PENDING_REVIEW 报告作出退回/通过决定；跨组织统一 NOT_FOUND。
 */
@Injectable()
export class GetMaintenanceReportReviewDetailUsecase {
  constructor(
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(command: GetMaintenanceReportCommand): Promise<MaintenanceReportDetailView> {
    assertMaintenanceReportReviewRole(command.session);
    assertMaintenanceReportId(command.reportId);
    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
    });
    const detail = await this.maintenanceReportQueryService.readReportDetail(command.reportId);
    if (detail === null || detail.report.ownerOrganizationId !== membership.organizationId) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在或不可访问', {
        reportId: command.reportId,
      });
    }
    return detail;
  }
}
