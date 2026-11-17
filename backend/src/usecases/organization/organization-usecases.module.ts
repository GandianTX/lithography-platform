// src/usecases/organization/organization-usecases.module.ts

import { Module } from '@nestjs/common';
import { AccountInstallerModule } from '@src/modules/account/account-installer.module';
import { PasswordModule } from '@src/modules/common/password/password.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { CheckAdminOrganizationNameUsecase } from './check-admin-organization-name.usecase';
import { CreateAdminOrganizationUsecase } from './create-admin-organization.usecase';
import { GetAdminCompanyAdminAccountDetailUsecase } from './get-admin-company-admin-account-detail.usecase';
import { GetAdminCompanyAdminBindingUsecase } from './get-admin-company-admin-binding.usecase';
import { GetAdminOrganizationDetailUsecase } from './get-admin-organization-detail.usecase';
import { ListAdminOrganizationNamesUsecase } from './list-admin-organization-names.usecase';
import { ListAdminOrganizationsUsecase } from './list-admin-organizations.usecase';
import { ListBoundLevelTwoAdminsUsecase } from './list-bound-level-two-admins.usecase';
import { ProvisionCompanyWithAdminUsecase } from './provision-company-with-admin.usecase';
import { ReissueLevelTwoCredentialUsecase } from './reissue-level-two-credential.usecase';
import { ResetLevelTwoCredentialUsecase } from './reset-level-two-credential.usecase';
import { UpdateAdminOrganizationUsecase } from './update-admin-organization.usecase';

/**
 * 组织（公司档案）用例模块。
 *
 * 任务 08.1 派生的管理员最小名称名单读用例，与 08.2 的完整列表、详情、新增与编辑
 * 用例同处一个模块；权限口径统一复用 `@core/account/policy/admin-scope.policy`。
 *
 * S2 起新增与编辑共用账号 base 与密码策略：`AccountInstallerModule` 提供
 * `AccountService` / 查询服务，`PasswordModule` 提供 `PasswordPolicyService`。
 */
@Module({
  imports: [LithographyModule, AccountInstallerModule, PasswordModule],
  providers: [
    ListAdminOrganizationNamesUsecase,
    ListAdminOrganizationsUsecase,
    GetAdminOrganizationDetailUsecase,
    CreateAdminOrganizationUsecase,
    ProvisionCompanyWithAdminUsecase,
    UpdateAdminOrganizationUsecase,
    CheckAdminOrganizationNameUsecase,
    GetAdminCompanyAdminBindingUsecase,
    GetAdminCompanyAdminAccountDetailUsecase,
    ListBoundLevelTwoAdminsUsecase,
    ReissueLevelTwoCredentialUsecase,
    ResetLevelTwoCredentialUsecase,
  ],
  exports: [
    ListAdminOrganizationNamesUsecase,
    ListAdminOrganizationsUsecase,
    GetAdminOrganizationDetailUsecase,
    CreateAdminOrganizationUsecase,
    ProvisionCompanyWithAdminUsecase,
    UpdateAdminOrganizationUsecase,
    CheckAdminOrganizationNameUsecase,
    GetAdminCompanyAdminBindingUsecase,
    GetAdminCompanyAdminAccountDetailUsecase,
    ListBoundLevelTwoAdminsUsecase,
    ReissueLevelTwoCredentialUsecase,
    ResetLevelTwoCredentialUsecase,
  ],
})
export class OrganizationUsecasesModule {}
