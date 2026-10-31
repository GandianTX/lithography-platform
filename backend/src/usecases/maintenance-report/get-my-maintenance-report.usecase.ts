// src/usecases/maintenance-report/get-my-maintenance-report.usecase.ts

import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import type { MaintenanceReportDetailView } from '@src/modules/lithography/maintenance-report.types';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { GetMaintenanceReportCommand } from './maintenance-report-command.types';
import {
  assertMaintenanceReportAuthorRole,
  assertMaintenanceReportId,
} from './maintenance-report-roles';

/**
 * 本人维修报告详情：同组织且报告负责人本人。
 *
 * 返回工作态内容、当前冻结版本（含版本附件清单）与审核历史；
 * 他人报告或跨组织统一 NOT_FOUND。
 */
@Injectable()
export class GetMyMaintenanceReportUsecase {
  constructor(
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(command: GetMaintenanceReportCommand): Promise<MaintenanceReportDetailView> {
    assertMaintenanceReportAuthorRole(command.session);
    assertMaintenanceReportId(command.reportId);
    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
    });
    const detail = await this.maintenanceReportQueryService.readReportDetail(command.reportId);
    if (
      detail === null ||
      detail.report.maintenanceEngineerAccountId !== command.session.accountId ||
      detail.report.ownerOrganizationId !== membership.organizationId
    ) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在或不可访问', {
        reportId: command.reportId,
      });
    }
    return detail;
  }
}
