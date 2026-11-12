// src/usecases/admin-document-database/list-admin-ai-reports.usecase.ts

import { DomainError, ADMIN_DOCUMENT_DATABASE_ERROR } from '@core/common/errors/domain-error';
import {
  applyDefaults,
  enforceMaxPageSize,
  isOffsetMode,
} from '@core/pagination/pagination.policy';
import { OffsetParams, PaginationParams } from '@core/pagination/pagination.types';
import { Injectable } from '@nestjs/common';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type {
  AdminAiReportListFilter,
  AdminAiReportListPage,
  AdminAiReportQueryFilter,
} from '@src/modules/lithography/admin-document-database.types';
import { AdminAiReportQueryService } from '@src/modules/lithography/queries/admin-ai-report.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  ADMIN_KEYWORD_ACCOUNT_LIMIT,
  assertKeywordAccountLimit,
  assertTimeRangeOrder,
  normalizeOptionalFilterText,
  normalizeOptionalKeyword,
} from './admin-document-database-filter.normalize';
import { assertAdminDocumentDatabasePermission } from './admin-document-database-permission';
import { enrichAdminAiReportListItems } from './enrich-admin-account-display';
import { resolveAdminDataScope } from './resolve-admin-data-scope';

/** 页大小上限：与 GraphQL 边界 PaginationArgs @Max(100) 对齐（统一分页策略） */
const MAX_PAGE_SIZE = 100;

/**
 * 管理员全局 AI 报告列表用例（PR3 只读聚合）
 *
 * - 精确授权先行：activeRole === SUPER_ADMIN（失败关闭）
 * - 仅 OFFSET 分页；排序由契约固定（创建时间倒序 + 主键倒序），不采纳客户端排序入参
 * - 列表不投影正文大字段（contentMd 仅详情返回），与「列表只投影必要字段」口径一致
 * - engineerKeyword 为跨账户域展示关键字：先经账户域解析为账号 ID 有界集合，
 *   命中超上限显式拒绝（不静默截断漏数），无命中时短路返回空页；
 *   requestNo / 类型 / 时间范围筛选保持在 SQL 侧执行
 */
@Injectable()
export class ListAdminAiReportsUsecase {
  constructor(
    private readonly adminAiReportQueryService: AdminAiReportQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(params: {
    session: UsecaseSession;
    pagination: PaginationParams;
    filter?: AdminAiReportListFilter;
  }): Promise<AdminAiReportListPage> {
    assertAdminDocumentDatabasePermission(params.session, '查看 AI 报告数据库');
    const scope = await resolveAdminDataScope({
      session: params.session,
      accountQueryService: this.accountQueryService,
      organizationContextService: this.organizationContextService,
    });

    if (!isOffsetMode(params.pagination)) {
      throw new DomainError(
        ADMIN_DOCUMENT_DATABASE_ERROR.INVALID_PARAMS,
        '管理员文档数据库列表仅支持 OFFSET 分页',
        { mode: params.pagination.mode },
      );
    }
    const { page, pageSize, withTotal } = enforceMaxPageSize(
      applyDefaults(params.pagination, {}),
      MAX_PAGE_SIZE,
    ) as OffsetParams;

    const filter = params.filter;
    assertTimeRangeOrder(filter?.createdAtFrom, filter?.createdAtTo);
    const engineerKeyword = normalizeOptionalKeyword(filter?.engineerKeyword);

    let engineerAccountIds: number[] | undefined;
    if (engineerKeyword) {
      const { accountIds, totalMatched } =
        await this.accountQueryService.findAccountIdsByDisplayKeyword(
          engineerKeyword,
          ADMIN_KEYWORD_ACCOUNT_LIMIT,
        );
      assertKeywordAccountLimit(totalMatched, engineerKeyword);
      engineerAccountIds = accountIds;
      if (engineerAccountIds.length === 0) {
        return {
          items: [],
          total: withTotal ? 0 : undefined,
          page,
          pageSize,
        };
      }
    }

    const queryFilter: AdminAiReportQueryFilter = {
      ownerOrganizationId: scope.ownerOrganizationId,
      requestNo: normalizeOptionalFilterText(filter?.requestNo),
      engineerAccountIds,
      reportType: normalizeOptionalFilterText(filter?.reportType),
      createdAtFrom: filter?.createdAtFrom,
      createdAtTo: filter?.createdAtTo,
    };

    const listPage = await this.adminAiReportQueryService.listAll({
      filter: queryFilter,
      pagination: { page, pageSize, withTotal: withTotal ?? false },
    });
    const items = await enrichAdminAiReportListItems(this.accountQueryService, listPage.items);
    return { ...listPage, items };
  }
}
