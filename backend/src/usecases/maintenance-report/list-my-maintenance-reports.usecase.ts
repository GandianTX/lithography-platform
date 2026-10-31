// src/usecases/maintenance-report/list-my-maintenance-reports.usecase.ts

import { Injectable } from '@nestjs/common';
import {
  MaintenanceReportQueryService,
  type MaintenanceReportListPage,
} from '@src/modules/lithography/queries/maintenance-report.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { MaintenanceReportSummaryView } from '@src/modules/lithography/maintenance-report.types';
import type { ListMyMaintenanceReportsCommand } from './maintenance-report-command.types';
import { normalizePagination } from './maintenance-report-pagination';
import { assertMaintenanceReportAuthorRole } from './maintenance-report-roles';

/** 本人报告列表：仅当前组织内由本人负责的报告，按更新时间倒序分页。 */
@Injectable()
export class ListMyMaintenanceReportsUsecase {
  constructor(
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(
    command: ListMyMaintenanceReportsCommand,
  ): Promise<MaintenanceReportListPage<MaintenanceReportSummaryView>> {
    assertMaintenanceReportAuthorRole(command.session);
    const pagination = normalizePagination(command.pagination);
    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
    });
    return this.maintenanceReportQueryService.listMine(
      command.session.accountId,
      membership.organizationId,
      pagination,
    );
  }
}
