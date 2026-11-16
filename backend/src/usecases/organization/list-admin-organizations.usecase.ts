// src/usecases/organization/list-admin-organizations.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { resolveLevelOneAdminScope } from '@core/account/policy/admin-scope.policy';
import { DomainError, PAGINATION_ERROR } from '@core/common/errors/domain-error';
import type { PaginationParams } from '@core/pagination/pagination.types';
import { Injectable } from '@nestjs/common';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { AdminOrganizationPage } from '@src/modules/lithography/organization.types';
import {
  normalizeBooleanFlag,
  normalizeOrganizationKeyword,
  normalizeOrganizationStatus,
} from './admin-organization.input.normalize';

/** 单页上限：与管理端选择器口径一致 */
const ADMIN_ORGANIZATION_PAGE_SIZE_MAX = 50;

export type ListAdminOrganizationsCommand = {
  readonly session: UsecaseSession;
  readonly keyword?: string | null;
  readonly status?: string | null;
  readonly isManagedCompany?: boolean | null;
  readonly isServiceProvider?: boolean | null;
  readonly pagination: PaginationParams;
};

/**
 * 一级管理员公司档案列表（任务 08.2）。
 *
 * 授权：仅一级管理员（`resolveLevelOneAdminScope`）；二级管理员的读入口是
 * `ListAdminOrganizationNamesUsecase` 的最小名称名单。
 *
 * 筛选：关键字匹配全称 / 编号 / 简称；状态、受管归类、维修资格可分别筛选。
 * 分页只支持 OFFSET，页码下限归一，页大小按上限 50 截断；排序固定为名称、主键升序。
 */
@Injectable()
export class ListAdminOrganizationsUsecase {
  constructor(private readonly organizationQueryService: OrganizationQueryService) {}

  async execute(command: ListAdminOrganizationsCommand): Promise<AdminOrganizationPage> {
    resolveLevelOneAdminScope(command.session, '查看公司档案');

    const { page, pageSize } = resolvePagination(command.pagination);

    return this.organizationQueryService.searchAdminOrganizations({
      keyword: normalizeOrganizationKeyword(command.keyword),
      status: normalizeOptionalStatus(command.status),
      isManagedCompany: normalizeOptionalFlag(
        command.isManagedCompany,
        'isManagedCompany',
        '受管公司',
      ),
      isServiceProvider: normalizeOptionalFlag(
        command.isServiceProvider,
        'isServiceProvider',
        '提供维修服务',
      ),
      pagination: { page, pageSize },
    });
  }
}

/** 仅支持 OFFSET 分页；页码/页大小下限归一，页大小按上限截断 */
function resolvePagination(pagination: PaginationParams): { page: number; pageSize: number } {
  if (pagination.mode !== 'OFFSET') {
    throw new DomainError(PAGINATION_ERROR.INVALID_PAGE_SIZE, '公司档案列表仅支持 OFFSET 分页');
  }
  return {
    page: Math.max(pagination.page, 1),
    pageSize: Math.min(Math.max(pagination.pageSize, 1), ADMIN_ORGANIZATION_PAGE_SIZE_MAX),
  };
}

/** 缺省 / null 表示不过滤，其余按枚举白名单校验 */
function normalizeOptionalStatus(value: string | null | undefined) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return normalizeOrganizationStatus(value);
}

/** 缺省 / null 表示不过滤，其余必须是真正的布尔值 */
function normalizeOptionalFlag(
  value: boolean | null | undefined,
  field: string,
  label: string,
): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return normalizeBooleanFlag(value, field, label);
}
