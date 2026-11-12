// src/usecases/admin-document-database/get-admin-repair-request-summary.usecase.ts

import { Injectable } from '@nestjs/common';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { AdminRepairRequestSummaryView } from '@src/modules/lithography/admin-document-database.types';
import { AdminRepairRequestQueryService } from '@src/modules/lithography/queries/admin-repair-request.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { assertAdminDocumentDatabasePermission } from './admin-document-database-permission';
import { assertPositiveId } from './admin-document-database-filter.normalize';
import { resolveAdminDataScope } from './resolve-admin-data-scope';
import { enrichAdminRepairRequestSummary } from './enrich-admin-account-display';

/**
 * 管理员维修申请只读摘要用例（PR3）。
 *
 * - 精确授权先行：activeRole === SUPER_ADMIN（失败关闭）
 * - 动态 ID 在首次 QueryService 调用前校验为安全正整数（usecase 是授权与业务语义边界）
 * - 摘要 = 管理员视角的申请全貌（含故障描述与申请正文），不进入既有
 *   客户/工程师详情链路（那条链路按归属判权，管理员越权读会被拒绝）
 * - 不存在与已删除统一 NOT_FOUND（QueryService 口径，防删除状态探测）
 */
@Injectable()
export class GetAdminRepairRequestSummaryUsecase {
  constructor(
    private readonly adminRepairRequestQueryService: AdminRepairRequestQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(params: {
    session: UsecaseSession;
    requestId: number;
  }): Promise<AdminRepairRequestSummaryView> {
    assertAdminDocumentDatabasePermission(params.session, '查看维修申请数据库');
    assertPositiveId(params.requestId, '维修申请 ID', 'requestId');

    const scope = await resolveAdminDataScope({
      session: params.session,
      accountQueryService: this.accountQueryService,
      organizationContextService: this.organizationContextService,
    });
    const result = await this.adminRepairRequestQueryService.findSummaryById(
      params.requestId,
      scope.ownerOrganizationId,
    );
    return enrichAdminRepairRequestSummary(this.accountQueryService, result);
  }
}
