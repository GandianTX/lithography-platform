// src/usecases/registration/search-registration-organizations.usecase.ts

import { DomainError, PAGINATION_ERROR } from '@core/common/errors';
import { Injectable } from '@nestjs/common';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { OrganizationRegistrationOptionPage } from '@src/modules/lithography/organization.types';
import { normalizeRegistrationOrganizationKeyword } from './registration-input.normalize';
import type { SearchRegistrationOrganizationsInput } from './search-registration-organizations.types';

/** 名称关键字长度上限：公开查询只做选择器检索，超长在输入层拒绝 */
const REGISTRATION_ORGANIZATION_KEYWORD_MAX_LENGTH = 100;

/** 单页上限：与查询服务一致，避免公开接口被用作批量导出 */
const REGISTRATION_ORGANIZATION_PAGE_SIZE_MAX = 50;

/**
 * Web 注册公司候选检索（公开只读，分页入口）。
 *
 * 资格口径固定为 `status = ACTIVE AND is_managed_company = true`，客户与工程师
 * 两类 Web 注册共用；维修服务资格不参与。只返回公司主键与名称，不涉及任何账号
 * 数据、审核权限或组织内部资料。
 *
 * 与无参的 `registrationOrganizations` 兼容入口并存：后者保持主线既有的
 * 「全部 ACTIVE 组织数组」契约，供小程序注册与凭据重提继续使用。
 * 客户端所选 organizationId 仍会在写入事务内按同一资格复核，本查询结果不作为
 * 公司具备注册资格的最终凭证。
 */
@Injectable()
export class SearchRegistrationOrganizationsUsecase {
  constructor(private readonly organizationQueryService: OrganizationQueryService) {}

  async execute(
    input: SearchRegistrationOrganizationsInput,
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
function resolvePagination(pagination: SearchRegistrationOrganizationsInput['pagination']): {
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
