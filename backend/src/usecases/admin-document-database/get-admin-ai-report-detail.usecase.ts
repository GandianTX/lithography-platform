// src/usecases/admin-document-database/get-admin-ai-report-detail.usecase.ts

import { Injectable } from '@nestjs/common';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { AdminAiReportDetailView } from '@src/modules/lithography/admin-document-database.types';
import { AdminAiReportQueryService } from '@src/modules/lithography/queries/admin-ai-report.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { assertAdminDocumentDatabasePermission } from './admin-document-database-permission';
import { assertPositiveId } from './admin-document-database-filter.normalize';
import { enrichAdminAiReportDetail } from './enrich-admin-account-display';
import { resolveAdminDataScope } from './resolve-admin-data-scope';

/**
 * 管理员 AI 报告只读详情用例（PR3，含正文 contentMd）。
 *
 * - 精确授权先行：activeRole === SUPER_ADMIN（失败关闭）
 * - 动态 ID 在首次 QueryService 调用前校验为安全正整数（usecase 是授权与业务语义边界）
 * - 只读正文：不提供生成、训练、修改、删除能力，不改既有
 *   (conversationId, reportType) 唯一约束
 * - 不存在统一 NOT_FOUND（QueryService 口径）
 */
@Injectable()
export class GetAdminAiReportDetailUsecase {
  constructor(
    private readonly adminAiReportQueryService: AdminAiReportQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(params: {
    session: UsecaseSession;
    reportId: number;
  }): Promise<AdminAiReportDetailView> {
    assertAdminDocumentDatabasePermission(params.session, '查看 AI 报告详情');
    assertPositiveId(params.reportId, 'AI 报告 ID', 'reportId');
    const scope = await resolveAdminDataScope({
      session: params.session,
      accountQueryService: this.accountQueryService,
      organizationContextService: this.organizationContextService,
    });

    const result = await this.adminAiReportQueryService.findDetailById(
      params.reportId,
      scope.ownerOrganizationId,
    );
    return enrichAdminAiReportDetail(this.accountQueryService, result);
  }
}
