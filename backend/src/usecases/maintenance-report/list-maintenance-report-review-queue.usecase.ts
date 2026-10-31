// src/usecases/maintenance-report/list-maintenance-report-review-queue.usecase.ts

import { Injectable } from '@nestjs/common';
import {
  MaintenanceReportQueryService,
  type MaintenanceReportListPage,
} from '@src/modules/lithography/queries/maintenance-report.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { MaintenanceReportSummaryView } from '@src/modules/lithography/maintenance-report.types';
import type { ListMaintenanceReportReviewQueueCommand } from './maintenance-report-command.types';
import { normalizePagination } from './maintenance-report-pagination';
import { assertMaintenanceReportReviewRole } from './maintenance-report-roles';

/** 审核队列：当前组织内 PENDING_REVIEW 报告，按提交时间升序分页（先提交先审）。 */
@Injectable()
export class ListMaintenanceReportReviewQueueUsecase {
  constructor(
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(
    command: ListMaintenanceReportReviewQueueCommand,
  ): Promise<MaintenanceReportListPage<MaintenanceReportSummaryView>> {
    assertMaintenanceReportReviewRole(command.session);
    const pagination = normalizePagination(command.pagination);
    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
    });
    return this.maintenanceReportQueryService.listReviewQueue(
      membership.organizationId,
      pagination,
    );
  }
}
