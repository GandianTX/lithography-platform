// src/usecases/admin-document-database/list-admin-repair-requests.usecase.ts

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
  AdminRepairRequestListFilter,
  AdminRepairRequestListPage,
  AdminRepairRequestQueryFilter,
} from '@src/modules/lithography/admin-document-database.types';
import { AdminRepairRequestQueryService } from '@src/modules/lithography/queries/admin-repair-request.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  ADMIN_KEYWORD_ACCOUNT_LIMIT,
  assertKeywordAccountLimit,
  assertTimeRangeOrder,
  normalizeOptionalFilterText,
  normalizeOptionalKeyword,
} from './admin-document-database-filter.normalize';
import { assertAdminDocumentDatabasePermission } from './admin-document-database-permission';
import { resolveAdminDataScope } from './resolve-admin-data-scope';
import { enrichAdminRepairRequestListItems } from './enrich-admin-account-display';

/** 页大小上限：与 GraphQL 边界 PaginationArgs @Max(100) 对齐（统一分页策略） */
const MAX_PAGE_SIZE = 100;

/**
 * 管理员全局维修申请列表用例（PR3 只读聚合）
 *
 * - 精确授权先行：activeRole === SUPER_ADMIN（失败关闭），守卫层 @Roles(SUPER_ADMIN) 只做粗准入
 * - 仅 OFFSET 分页；排序由契约固定（创建时间倒序 + 主键倒序），不采纳客户端排序入参
 * - customerKeyword 为跨账户域展示关键字：先经账户域解析为账号 ID 有界集合，
 *   命中超上限显式拒绝（不静默截断漏数），无命中时短路返回空页，不再发起本域查询；
 *   关键字筛选整体保持在 SQL 侧执行，保证分页正确性（不做取页后过滤）
 * - 默认仅未删除申请（与既有维修申请读模型口径一致）
 */
@Injectable()
export class ListAdminRepairRequestsUsecase {
  constructor(
    private readonly adminRepairRequestQueryService: AdminRepairRequestQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(params: {
    session: UsecaseSession;
    pagination: PaginationParams;
    filter?: AdminRepairRequestListFilter;
  }): Promise<AdminRepairRequestListPage> {
    assertAdminDocumentDatabasePermission(params.session, '查看维修申请数据库');

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
    const customerKeyword = normalizeOptionalKeyword(filter?.customerKeyword);
    const scope = await resolveAdminDataScope({
      session: params.session,
      accountQueryService: this.accountQueryService,
      organizationContextService: this.organizationContextService,
    });

    let customerAccountIds: number[] | undefined;
    if (customerKeyword) {
      const { accountIds, totalMatched } =
        await this.accountQueryService.findAccountIdsByDisplayKeyword(
          customerKeyword,
          ADMIN_KEYWORD_ACCOUNT_LIMIT,
        );
      assertKeywordAccountLimit(totalMatched, customerKeyword);
      customerAccountIds = accountIds;
      if (customerAccountIds.length === 0) {
        return {
          items: [],
          total: withTotal ? 0 : undefined,
          page,
          pageSize,
        };
      }
    }

    const queryFilter: AdminRepairRequestQueryFilter = {
      ownerOrganizationId: scope.ownerOrganizationId,
      requestNo: normalizeOptionalFilterText(filter?.requestNo),
      customerAccountIds,
      equipmentModelId: filter?.equipmentModelId,
      errorCode: normalizeOptionalFilterText(filter?.errorCode),
      isAccepted: filter?.isAccepted,
      createdAtFrom: filter?.createdAtFrom,
      createdAtTo: filter?.createdAtTo,
    };

    const listPage = await this.adminRepairRequestQueryService.listAll({
      filter: queryFilter,
      pagination: { page, pageSize, withTotal: withTotal ?? false },
    });
    const items = await enrichAdminRepairRequestListItems(this.accountQueryService, listPage.items);
    return { ...listPage, items };
  }
}
