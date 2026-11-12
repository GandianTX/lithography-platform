// src/usecases/admin-document-database/list-admin-ai-conversations.usecase.ts

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
  AdminAiConversationListFilter,
  AdminAiConversationListPage,
  AdminAiConversationQueryFilter,
} from '@src/modules/lithography/admin-document-database.types';
import { AdminAiConversationQueryService } from '@src/modules/lithography/queries/admin-ai-conversation.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  ADMIN_KEYWORD_ACCOUNT_LIMIT,
  assertKeywordAccountLimit,
  assertTimeRangeOrder,
  normalizeOptionalFilterText,
  normalizeOptionalKeyword,
} from './admin-document-database-filter.normalize';
import { assertAdminDocumentDatabasePermission } from './admin-document-database-permission';
import { enrichAdminAiConversationListItems } from './enrich-admin-account-display';
import { resolveAdminDataScope } from './resolve-admin-data-scope';

/** 页大小上限：与 GraphQL 边界 PaginationArgs @Max(100) 对齐（统一分页策略） */
const MAX_PAGE_SIZE = 100;

/**
 * 管理员全局 AI 会话列表用例（PR3 只读聚合）
 *
 * - 精确授权先行：activeRole === SUPER_ADMIN（失败关闭）
 * - 仅 OFFSET 分页；排序由契约固定（创建时间倒序 + 主键倒序），不采纳客户端排序入参
 * - engineerKeyword 为跨账户域展示关键字：先经账户域解析为账号 ID 有界集合，
 *   命中超上限显式拒绝（不静默截断漏数），无命中时短路返回空页；
 *   requestNo / 状态 / 时间范围筛选保持在 SQL 侧执行
 * - 会话消息数 / 报告数来自真实聚合统计，不伪造演示数字
 */
@Injectable()
export class ListAdminAiConversationsUsecase {
  constructor(
    private readonly adminAiConversationQueryService: AdminAiConversationQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(params: {
    session: UsecaseSession;
    pagination: PaginationParams;
    filter?: AdminAiConversationListFilter;
  }): Promise<AdminAiConversationListPage> {
    assertAdminDocumentDatabasePermission(params.session, '查看 AI 会话数据库');
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

    const queryFilter: AdminAiConversationQueryFilter = {
      ownerOrganizationId: scope.ownerOrganizationId,
      requestNo: normalizeOptionalFilterText(filter?.requestNo),
      engineerAccountIds,
      status: filter?.status,
      createdAtFrom: filter?.createdAtFrom,
      createdAtTo: filter?.createdAtTo,
    };

    const listPage = await this.adminAiConversationQueryService.listAll({
      filter: queryFilter,
      pagination: { page, pageSize, withTotal: withTotal ?? false },
    });
    const items = await enrichAdminAiConversationListItems(
      this.accountQueryService,
      listPage.items,
    );
    return { ...listPage, items };
  }
}
