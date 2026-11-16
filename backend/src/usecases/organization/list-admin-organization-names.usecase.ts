// src/usecases/organization/list-admin-organization-names.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { DomainError, PAGINATION_ERROR } from '@core/common/errors/domain-error';
import { resolveAdminScope } from '@core/account/policy/admin-scope.policy';
import type { PaginationParams } from '@core/pagination/pagination.types';
import { Injectable } from '@nestjs/common';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { OrganizationNameOptionPage } from '@src/modules/lithography/organization.types';
import { normalizeOrganizationKeyword } from './admin-organization.input.normalize';

/** 单页上限：与管理端列表其余入口一致的选择器上限 */
const ADMIN_ORGANIZATION_PAGE_SIZE_MAX = 50;

export type ListAdminOrganizationNamesCommand = {
  readonly session: UsecaseSession;
  readonly keyword?: string | null;
  readonly pagination: PaginationParams;
};

/**
 * 管理员公司名称名单（R015 最小字段视图，任务 08.2 / 08.3 共用）。
 *
 * 授权口径：
 * - 一级与二级管理员均可跨公司查看名称名单（二级只读最小字段）；
 * - 等级与可信公司归属按请求期数据库复核结果裁决（`resolveAdminScope`），
 *   等级缺失、非法或二级缺少可信公司一律 `FORBIDDEN`；
 * - 本名单刻意不复用公开注册候选（`ACTIVE + 受管`），也不把管理员名单
 *   当作公开注册/报修候选使用。
 *
 * 输出只含 `id` / `name`，不含联系方式、成员、业务详情、受管或维修资格。
 */
@Injectable()
export class ListAdminOrganizationNamesUsecase {
  constructor(private readonly organizationQueryService: OrganizationQueryService) {}

  async execute(command: ListAdminOrganizationNamesCommand): Promise<OrganizationNameOptionPage> {
    resolveAdminScope(command.session, '查看公司名称名单');

    const { page, pageSize } = resolvePagination(command.pagination);
    return this.organizationQueryService.searchOrganizationNameOptions({
      keyword: normalizeOrganizationKeyword(command.keyword),
      pagination: { page, pageSize },
    });
  }
}

/** 仅支持 OFFSET 分页；页码/页大小下限归一，页大小按上限截断 */
function resolvePagination(pagination: PaginationParams): { page: number; pageSize: number } {
  if (pagination.mode !== 'OFFSET') {
    throw new DomainError(PAGINATION_ERROR.INVALID_PAGE_SIZE, '公司名称名单仅支持 OFFSET 分页');
  }
  return {
    page: Math.max(pagination.page, 1),
    pageSize: Math.min(Math.max(pagination.pageSize, 1), ADMIN_ORGANIZATION_PAGE_SIZE_MAX),
  };
}
