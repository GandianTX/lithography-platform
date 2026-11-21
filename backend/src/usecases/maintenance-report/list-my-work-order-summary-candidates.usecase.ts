// src/usecases/maintenance-report/list-my-work-order-summary-candidates.usecase.ts

import { Injectable } from '@nestjs/common';
import type { WorkOrderSummaryCandidateView } from '@src/modules/lithography/maintenance-report.types';
import {
  MaintenanceReportQueryService,
  type MaintenanceReportListPage,
} from '@src/modules/lithography/queries/maintenance-report.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { ListMyWorkOrderSummaryCandidatesCommand } from './maintenance-report-command.types';
import { normalizePagination } from './maintenance-report-pagination';
import { assertMaintenanceReportAuthorRole } from './maintenance-report-roles';

/**
 * 工单维修总结待填写列表：仅当前工程师本人接单、已结单、同组织的工单。
 *
 * 草稿仍在列表内（续填同一份）；正式提交后由 SQL 过滤移出，
 * 不依赖前端二次过滤，也不以是否存在 AI 评价作为判定条件。
 */
@Injectable()
export class ListMyWorkOrderSummaryCandidatesUsecase {
  constructor(
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(
    command: ListMyWorkOrderSummaryCandidatesCommand,
  ): Promise<MaintenanceReportListPage<WorkOrderSummaryCandidateView>> {
    assertMaintenanceReportAuthorRole(command.session);
    const pagination = normalizePagination(command.pagination);
    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
    });
    return this.maintenanceReportQueryService.listWorkOrderSummaryCandidates({
      engineerAccountId: command.session.accountId,
      ownerOrganizationId: membership.organizationId,
      pagination,
    });
  }
}
