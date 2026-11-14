// src/usecases/registration/list-registration-organizations.usecase.ts

import { DomainError, PAGINATION_ERROR } from '@core/common/errors';
import { Injectable } from '@nestjs/common';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { OrganizationRegistrationOptionPage } from '@src/modules/lithography/organization.types';
import { normalizeRegistrationOrganizationKeyword } from './registration-input.normalize';
import type { ListRegistrationOrganizationsInput } from './list-registration-organizations.types';

/** 名称关键字长度上限：公开查询只做选择器检索，超长在输入层拒绝 */
const REGISTRATION_ORGANIZATION_KEYWORD_MAX_LENGTH = 100;

/** 单页上限：与查询服务一致，避免公开接口被用作批量导出 */
const REGISTRATION_ORGANIZATION_PAGE_SIZE_MAX = 50;

/**
 * 注册公司候选查询（公开只读）。
 *
 * 资格口径固定为 `status = ACTIVE AND is_managed_company = true`，客户与工程师
 * 两类 Web 注册共用；维修服务资格不参与。只返回公司主键与名称，不涉及任何账号
 * 数据、审核权限或组织内部资料。
 *
 * 客户端所选 organizationId 仍会在写入事务内按同一资格复核，本查询结果不作为
 * 公司具备注册资格的最终凭证。
 */
@Injectable()
export class ListRegistrationOrganizationsUsecase {
  constructor(private readonly organizationQueryService: OrganizationQueryService) {}

  async execute(
    input: ListRegistrationOrganizationsInput,
  ): Promise<OrganizationRegistrationOptionPage> {
    const { page, pageSize } = resolvePagination(input.pagination);
    return this.organizationQueryService.searchEligibleRegistrationOptions({
      keyword: normalizeRegistrationOrganizationKeyword(
        input.keyword,
        REGISTRATION_ORGANIZATION_KEYWORD_MAX_LENGTH,
      ),
      pagination: { page, pageSize },
    });
  }
}

/** 仅支持 OFFSET 分页；页码/页大小下限归一，页大小按上限截断 */
function resolvePagination(pagination: ListRegistrationOrganizationsInput['pagination']): {
  page: number;
  pageSize: number;
} {
  if (pagination.mode !== 'OFFSET') {
    throw new DomainError(PAGINATION_ERROR.INVALID_PAGE_SIZE, '注册公司检索仅支持 OFFSET 分页');
  }
  return {
    page: Math.max(pagination.page, 1),
    pageSize: Math.min(Math.max(pagination.pageSize, 1), REGISTRATION_ORGANIZATION_PAGE_SIZE_MAX),
  };
}
