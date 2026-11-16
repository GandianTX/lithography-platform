// src/adapters/api/graphql/account/my-account-settings.resolver.ts

import { mapJwtToUsecaseSession, type UsecaseSession } from '@app-types/auth/session.types';
import { AuthenticatedSessionUser } from '@app-types/auth/session-restriction.types';
import { JwtPayload } from '@app-types/jwt.types';
import { ValidateInput } from '@adapters/api/graphql/common/validate-input.decorator';
import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UpdateMyAccountProfileInput } from '@src/adapters/api/graphql/account/dto/update-my-account-profile.input';
import { UpdateMyAccountSettingsInput } from '@src/adapters/api/graphql/account/dto/update-my-account-settings.input';
import {
  UpdateMyAccountSettingsResultDTO,
  toUpdateMyAccountSettingsResultDTO,
} from '@src/adapters/api/graphql/account/dto/update-my-account-settings-result.dto';
import { ChangeMyPasswordInput } from '@src/adapters/api/graphql/account/dto/change-my-password.input';
import {
  ChangeMyPasswordResultDTO,
  toChangeMyPasswordResultDTO,
} from '@src/adapters/api/graphql/account/dto/change-my-password-result.dto';
import { SupplementMyCustomerCompanyInput } from '@src/adapters/api/graphql/account/dto/supplement-my-customer-company.input';
import {
  SupplementMyCustomerCompanyResultDTO,
  toSupplementMyCustomerCompanyResultDTO,
} from '@src/adapters/api/graphql/account/dto/supplement-my-customer-company-result.dto';
import {
  MyAccountSettingsDTO,
  toMyAccountSettingsDTO,
} from '@src/adapters/api/graphql/account/dto/my-account-settings.dto';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { MustChangePasswordGuard } from '@src/adapters/api/graphql/guards/must-change-password.guard';
import { ChangeMyPasswordUsecase } from '@src/usecases/account/change-my-password.usecase';
import { GetMyAccountSettingsUsecase } from '@src/usecases/account/get-my-account-settings.usecase';
import { SupplementMyCustomerCompanyUsecase } from '@src/usecases/account/supplement-my-customer-company.usecase';
import { UpdateMyAccountSettingsUsecase } from '@src/usecases/account/update-my-account-settings.usecase';

/**
 * 当前用户账号设置解析器（P1 只读 + P2 设置更新 + P3 自助改密）。
 *
 * 职责边界（`docs/api/adapters.rules.md`）：
 * - 只做协议映射、Guard/Session 传递与 View → DTO 薄映射；三源角色收敛、双字段状态一致性、
 *   资料缺失失败关闭、凭据合并 / 唯一性预检查 / 事务全部归 Usecase / QueryService；
 * - 不依赖 modules(service)、QueryService、Repository 或 infrastructure；
 * - 错误不在此捕获：DomainError 直接上抛进入全局 GraphQL exception filter。
 *
 * 准入：`JwtAuthGuard` + `MustChangePasswordGuard`——`SUPER_ADMIN` / `ENGINEER` / `CUSTOMER`
 * 均可管理**自己的**账号设置（契约见 `docs/api/account-write-current.md`），故不加 `@Roles`；
 * 待审 / 已拒绝 / 资格未生效的受限会话仍需查看与维护本人资料，但强制改密完成前一律拒绝。
 * 目标账号只能来自已认证 Session，各入口（1 Query + 2 Mutation + 1 窄写 Mutation +
 * 1 补录 Mutation）**刻意不接收任何目标账号 ID 参数**，结构上杜绝读取 / 修改他人设置的入口。
 * Web 正式资料页使用四字段窄写入口 `updateMyAccountProfile`；凭据与展示公司字段的广写
 * 入口 `updateMyAccountSettings` 保持既有兼容语义。
 */
@Resolver()
export class MyAccountSettingsResolver {
  constructor(
    private readonly getMyAccountSettingsUsecase: GetMyAccountSettingsUsecase,
    private readonly updateMyAccountSettingsUsecase: UpdateMyAccountSettingsUsecase,
    private readonly supplementMyCustomerCompanyUsecase: SupplementMyCustomerCompanyUsecase,
    private readonly changeMyPasswordUsecase: ChangeMyPasswordUsecase,
  ) {}

  /**
   * 读取当前登录用户自己的账号设置（只读）。
   * 角色与状态为只读展示字段；响应不含 accountId、密码、Token、identityHint 等敏感字段。
   */
  @UseGuards(JwtAuthGuard, MustChangePasswordGuard)
  @Query(() => MyAccountSettingsDTO, {
    name: 'myAccountSettings',
    description: '读取当前登录用户的账号设置（只读）',
  })
  async myAccountSettings(
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<MyAccountSettingsDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const view = await this.getMyAccountSettingsUsecase.execute({
      session,
      trustedOrganizations: {
        customerOrganizationId: user.customerOrganizationId,
        engineerOrganizationId: user.engineerOrganizationId,
        adminOrganizationId: user.adminOrganizationId,
      },
    });
    return toMyAccountSettingsDTO(view);
  }

  /**
   * 更新当前登录用户自己的账号设置（登录名 / 登录邮箱 / 昵称 / 公司名称 / 电话 / 联系邮箱）。
   * 三态语义见 `UpdateMyAccountSettingsInput`；「至少保留一个登录方式」、唯一性预检查与
   * 数据库唯一索引竞争裁决全部由 Usecase 在事务内完成，本方法不做任何业务判断。
   *
   * 受限会话的字段白名单由 Usecase 依据请求期复核结论（`user.restriction`）裁决：
   * Resolver 只透传事实，不自行放宽或收紧。
   */
  @UseGuards(JwtAuthGuard, MustChangePasswordGuard)
  @Mutation(() => UpdateMyAccountSettingsResultDTO, {
    name: 'updateMyAccountSettings',
    description: '更新当前登录用户的账号设置',
  })
  @ValidateInput()
  async updateMyAccountSettings(
    @Args('input') input: UpdateMyAccountSettingsInput,
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<UpdateMyAccountSettingsResultDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const result = await this.updateMyAccountSettingsUsecase.execute({
      session,
      restriction: user.restriction,
      trustedOrganizations: {
        customerOrganizationId: user.customerOrganizationId,
        engineerOrganizationId: user.engineerOrganizationId,
        adminOrganizationId: user.adminOrganizationId,
      },
      loginName: input.loginName,
      loginEmail: input.loginEmail,
      nickname: input.nickname,
      realName: input.realName,
      companyName: input.companyName,
      phone: input.phone,
      contactEmail: input.contactEmail,
    });
    return toUpdateMyAccountSettingsResultDTO(result);
  }

  /**
   * 更新当前登录用户的资料（Web 正式资料页窄写入口，任务 02 F5）。
   *
   * 输入只含昵称、真实姓名、电话、联系邮箱四个字段；登录名 / 登录邮箱 / 公司名称 /
   * 账号 ID / 角色 / 状态 / 等级 / 客户归属在 Schema 层面**不存在**，客户端硬塞会被
   * GraphQL 变量校验拒绝。写入编排复用 `UpdateMyAccountSettingsUsecase` 的既有事务、
   * 三态合并、受限白名单与失败分类，本方法只透传 Session、限制状态与四个资料字段。
   */
  @UseGuards(JwtAuthGuard, MustChangePasswordGuard)
  @Mutation(() => UpdateMyAccountSettingsResultDTO, {
    name: 'updateMyAccountProfile',
    description: '更新当前登录用户的资料（窄写：昵称、真实姓名、电话、联系邮箱）',
  })
  @ValidateInput()
  async updateMyAccountProfile(
    @Args('input') input: UpdateMyAccountProfileInput,
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<UpdateMyAccountSettingsResultDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const result = await this.updateMyAccountSettingsUsecase.execute({
      session,
      restriction: user.restriction,
      trustedOrganizations: {
        customerOrganizationId: user.customerOrganizationId,
        engineerOrganizationId: user.engineerOrganizationId,
        adminOrganizationId: user.adminOrganizationId,
      },
      loginName: undefined,
      loginEmail: undefined,
      nickname: input.nickname,
      realName: input.realName,
      companyName: undefined,
      phone: input.phone,
      contactEmail: input.contactEmail,
    });
    return toUpdateMyAccountSettingsResultDTO(result);
  }

  /**
   * 缺归属客户补录本人公司归属（任务 02.4 / D1）。
   *
   * 公司归属写入 `base_user_info.customer_organization_id` 并同事务补 CUSTOMER 成员关系，
   * 不写展示字段 `company_name`。角色 / 状态 / 是否已归属 / 组织可用性 / 并发裁决全部由
   * Usecase 在行锁内完成，本方法只透传 Session、限制状态与两个互斥入参。
   */
  @UseGuards(JwtAuthGuard, MustChangePasswordGuard)
  @Mutation(() => SupplementMyCustomerCompanyResultDTO, {
    name: 'supplementMyCustomerCompany',
    description: '补录当前客户的所属公司（仅缺归属的客户可用）',
  })
  @ValidateInput()
  async supplementMyCustomerCompany(
    @Args('input') input: SupplementMyCustomerCompanyInput,
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<SupplementMyCustomerCompanyResultDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const result = await this.supplementMyCustomerCompanyUsecase.execute({
      session,
      restriction: user.restriction,
      organizationId: input.organizationId,
      organizationName: input.organizationName,
    });
    return toSupplementMyCustomerCompanyResultDTO(result);
  }

  /**
   * 当前登录用户自助修改登录密码。当前密码校验、新密码策略与哈希落库由 Usecase 完成；
   * 成功结果不声称服务端撤销了已签发 Token（旧 Token 按现有契约自然过期）。
   */
  @UseGuards(JwtAuthGuard)
  @Mutation(() => ChangeMyPasswordResultDTO, {
    name: 'changeMyPassword',
    description: '当前登录用户修改自己的登录密码',
  })
  @ValidateInput()
  async changeMyPassword(
    @Args('input') input: ChangeMyPasswordInput,
    @currentUser() user: JwtPayload,
  ): Promise<ChangeMyPasswordResultDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const result = await this.changeMyPasswordUsecase.execute({
      session,
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
    });
    return toChangeMyPasswordResultDTO(result);
  }
}
