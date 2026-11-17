// src/usecases/admin-document-database/get-admin-document-database-stats.usecase.ts

import { Injectable } from '@nestjs/common';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { AdminAiConversationQueryService } from '@src/modules/lithography/queries/admin-ai-conversation.query.service';
import { AdminAiReportQueryService } from '@src/modules/lithography/queries/admin-ai-report.query.service';
import { AdminRepairRequestQueryService } from '@src/modules/lithography/queries/admin-repair-request.query.service';
import type { AdminDocumentDatabaseStatsView } from '@src/modules/lithography/admin-document-database.types';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { assertAdminDocumentDatabasePermission } from './admin-document-database-permission';
import { resolveAdminOrganizationScope } from './admin-organization-scope';

/**
 * 管理员文档数据库统计用例（PR3）。
 *
 * 四类统计口径与各标签默认列表过滤一致（计划表 S3.3）：
 * - 维修申请 / 参考资料：不含软删除项；
 * - AI 会话 / AI 报告：无软删除概念，计全量；
 * - 参考资料：复用既有参考资料读链路的默认过滤（deprecated = false），
 *   以 pageSize=1 的 withTotal 查询取真实总数，不伪造演示数字。
 *
 * A-PR0 §4.3：参考资料统计与资料列表使用相同组织范围（经可信组织上下文解析）；
 * 维修申请统计与工单列表共用 `resolveAdminOrganizationScope`：一级全公司、二级本公司，
 * 保证统计与列表 `total` 口径一致；AI 会话/报告保持全量口径不变。
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
    assertAdminDocumentDatabasePermission(params.session, '查看文档数据库统计');

    // 与工单列表/详情共用同一组织范围解析：一级无需组织，二级无组织失败关闭
    const organizationScope = await resolveAdminOrganizationScope({
      session: params.session,
      accountQueryService: this.accountQueryService,
      trustedOrganizationContext: this.organizationContextService,
    });

    // 参考资料读链路本身要求组织（A-PR0 §4.3）：一级管理员无成员关系时保持既有失败关闭，
    // 不伪造全局数字；工单统计按 scope 口径（一级全公司 / 二级本公司）。
    const referenceOrganizationId =
      organizationScope.organizationId ??
      (
        await this.organizationContextService.tryResolveForAccount({
          accountId: params.session.accountId,
        })
      )?.organizationId ??
      null;
    if (referenceOrganizationId === null) {
      throw new DomainError(
        PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
        '参考资料统计需要有效的组织成员关系',
      );
    }

    const [repairRequestTotal, aiConversationTotal, aiReportTotal, referenceDocumentPage] =
      await Promise.all([
        this.adminRepairRequestQueryService.countAll(organizationScope.organizationId),
        this.adminAiConversationQueryService.countAll(),
        this.adminAiReportQueryService.countAll(),
        this.referenceDocumentQueryService.listDocuments({
          filter: {},
          pagination: { page: 1, pageSize: 1, withTotal: true },
          organizationId: referenceOrganizationId,
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
