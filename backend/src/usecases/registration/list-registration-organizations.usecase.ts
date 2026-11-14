// src/usecases/registration/list-registration-organizations.usecase.ts

import { Injectable } from '@nestjs/common';
import type { OrganizationRegistrationOption } from '@src/modules/lithography/organization.types';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';

/**
 * 注册组织选项查询（公开只读，兼容入口）。
 *
 * 保持仓库主线既有契约：无参数、只返回 `ACTIVE` 组织的主键与名称数组，
 * 供小程序注册与拒绝后凭据重提等既有调用方继续使用；Web 注册页改用
 * 独立的 `registrationOrganizationSearch`（受管公司 + 关键字 + 分页）。
 *
 * 客户端所选 organizationId 仍会在写入事务内复核，本查询结果不作为组织
 * 有效性的最终凭证；不涉及任何账号数据、审核权限或组织内部资料。
 */
@Injectable()
export class ListRegistrationOrganizationsUsecase {
  constructor(private readonly organizationQueryService: OrganizationQueryService) {}

  async execute(): Promise<OrganizationRegistrationOption[]> {
    return this.organizationQueryService.listActiveRegistrationOptions();
  }
}
