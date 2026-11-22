// src/usecases/admin-document-database/get-admin-document-database-stats.usecase.ts

import { Injectable } from '@nestjs/common';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { AdminAiConversationQueryService } from '@src/modules/lithography/queries/admin-ai-conversation.query.service';
import { AdminAiReportQueryService } from '@src/modules/lithography/queries/admin-ai-report.query.service';
import { AdminRepairRequestQueryService } from '@src/modules/lithography/queries/admin-repair-request.query.service';
import type { AdminDocumentDatabaseStatsView } from '@src/modules/lithography/admin-document-database.types';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { assertAdminDocumentDatabaseGlobalAccess } from './admin-document-database-permission';

/**
 * 管理员文档数据库统计用例（PR3）。
 *
 * 四类统计口径与各标签默认列表过滤一致（计划表 S3.3）：
 * - 维修申请 / 参考资料：不含软删除项；
 * - AI 会话 / AI 报告：无软删除概念，计全量；
 * - 参考资料：复用既有参考资料读链路的默认过滤（deprecated = false），
 *   以 pageSize=1 的 withTotal 查询取真实总数，不伪造演示数字。
 *
 * 2026-11-21 需求调整：资料列表读侧一级管理员为 GLOBAL（功能 V5.6 R055、
 * reference-document-read-scope.ts：一级不按组织过滤、不依赖本人成员关系）；
 * 统计与列表必须同一口径，否则页面统计数字与列表条数不一致。
 * 因此参考资料统计传 organizationId: null（全公司正式资料，仍不含软删）；
 * 组织解析仅保留在全域授权门槛内（L1 仍须唯一有效 SUPER_ADMIN 成员关系）。
 * 不改造维修申请、AI 会话/报告等其他业务的组织设计。
 */
@Injectable()
export class GetAdminDocumentDatabaseStatsUsecase {
  constructor(
    private readonly adminRepairRequestQueryService: AdminRepairRequestQueryService,
    private readonly adminAiConversationQueryService: AdminAiConversationQueryService,
    private readonly adminAiReportQueryService: AdminAiReportQueryService,
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    private readonly accountQueryService: AccountQueryService,
  ) {}

  async execute(params: { session: UsecaseSession }): Promise<AdminDocumentDatabaseStatsView> {
    // 等级与成员事实先于任何统计读取完成（F1：二级/缺级/缺成员一律失败关闭）；
    // 成员关系仅用于全域授权门槛，不参与统计范围（统计范围为一级管理员全公司）
    await assertAdminDocumentDatabaseGlobalAccess({
      session: params.session,
      accountQueryService: this.accountQueryService,
      organizationContextService: this.organizationContextService,
      actionLabel: '查看文档数据库统计',
    });

    const [repairRequestTotal, aiConversationTotal, aiReportTotal, referenceDocumentPage] =
      await Promise.all([
        this.adminRepairRequestQueryService.countAll(null),
        this.adminAiConversationQueryService.countAll(),
        this.adminAiReportQueryService.countAll(),
        // 一级管理员文档数据库为全域口径：参考资料统计与普通资料库同源，
        // 只计未软删、已上架、归属已确认的正式资料（下架/未知归属不计入）
        this.referenceDocumentQueryService.listDocuments({
          filter: {},
          pagination: { page: 1, pageSize: 1, withTotal: true },
          // 与资料列表读侧（resolveReferenceDocumentReadScope）同一口径：
          // 一级管理员 GLOBAL（全公司），null = 不按组织过滤
          scope: { kind: 'GLOBAL' },
        }),
      ]);

    return {
      repairRequestTotal,
      aiConversationTotal,
      aiReportTotal,
      referenceDocumentTotal: referenceDocumentPage.total ?? 0,
    };
  }
}
