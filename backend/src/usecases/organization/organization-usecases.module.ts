// src/usecases/organization/organization-usecases.module.ts

import { Module } from '@nestjs/common';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { CreateAdminOrganizationUsecase } from './create-admin-organization.usecase';
import { GetAdminOrganizationDetailUsecase } from './get-admin-organization-detail.usecase';
import { ListAdminOrganizationNamesUsecase } from './list-admin-organization-names.usecase';
import { ListAdminOrganizationsUsecase } from './list-admin-organizations.usecase';
import { UpdateAdminOrganizationUsecase } from './update-admin-organization.usecase';

/**
 * 组织（公司档案）用例模块。
 *
 * 任务 08.1 派生的管理员最小名称名单读用例，与 08.2 的完整列表、详情、新增与编辑
 * 用例同处一个模块；权限口径统一复用 `@core/account/policy/admin-scope.policy`。
 */
@Module({
  imports: [LithographyModule],
  providers: [
    ListAdminOrganizationNamesUsecase,
    ListAdminOrganizationsUsecase,
    GetAdminOrganizationDetailUsecase,
    CreateAdminOrganizationUsecase,
    UpdateAdminOrganizationUsecase,
  ],
  exports: [
    ListAdminOrganizationNamesUsecase,
    ListAdminOrganizationsUsecase,
    GetAdminOrganizationDetailUsecase,
    CreateAdminOrganizationUsecase,
    UpdateAdminOrganizationUsecase,
  ],
})
export class OrganizationUsecasesModule {}
