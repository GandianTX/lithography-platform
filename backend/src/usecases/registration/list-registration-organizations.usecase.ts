// src/usecases/registration/list-registration-organizations.usecase.ts

import { Injectable } from '@nestjs/common';
import type { OrganizationRegistrationOption } from '@src/modules/lithography/organization.types';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';

/**
 * 注册组织选项查询（公开只读）。
 *
 * 只返回 `ACTIVE` 组织的主键与名称，供注册页选择组织；不区分客户/工程师——
 * 两类注册都必须选择有效组织。客户端所选 organizationId 仍会在写入事务内复核，
 * 本查询结果不作为组织有效性的最终凭证。
 *
 * 不涉及任何账号数据、审核权限或组织内部资料。
 */
@Injectable()
export class ListRegistrationOrganizationsUsecase {
  constructor(private readonly organizationQueryService: OrganizationQueryService) {}

  async execute(): Promise<OrganizationRegistrationOption[]> {
    return this.organizationQueryService.listActiveRegistrationOptions();
  }
}
