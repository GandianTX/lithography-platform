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
    const ownership = await this.maintenanceReportQueryService.readReportOwnership(
      command.reportId,
    );
    if (ownership === null) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在或不可访问', {
        reportId: command.reportId,
      });
    }
    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
    });
    if (
      ownership.maintenanceEngineerAccountId !== command.session.accountId ||
      ownership.ownerOrganizationId !== membership.organizationId
    ) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在或不可访问', {
        reportId: command.reportId,
      });
    }
    // 授权后才加载完整内容；详情读取仍携带范围谓词，不依赖第一次检查。
    const detail = await this.maintenanceReportQueryService.readReportDetail(
      command.reportId,
      undefined,
      {
        ownerOrganizationId: membership.organizationId,
        maintenanceEngineerAccountId: command.session.accountId,
      },
    );
    if (detail === null) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在或不可访问', {
        reportId: command.reportId,
      });
    }
    return detail;
  }
}
