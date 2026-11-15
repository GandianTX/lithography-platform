// src/adapters/api/graphql/account/admin-user.resolver.ts

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { mapJwtToUsecaseSession, type UsecaseSession } from '@app-types/auth/session.types';
import { JwtPayload } from '@app-types/jwt.types';
import { ValidateInput } from '@adapters/api/graphql/common/validate-input.decorator';
import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { mapGqlToCoreParams } from '@src/adapters/api/graphql/pagination.mapper';
import { PaginationArgs } from '@src/adapters/api/graphql/pagination.args';
import { AdminCreateUserInput } from '@src/adapters/api/graphql/account/dto/admin-create-user.input';
import { AdminResetUserPasswordInput } from '@src/adapters/api/graphql/account/dto/admin-reset-user-password.input';
import { AdminResetUserPasswordToDefaultInput } from '@src/adapters/api/graphql/account/dto/admin-reset-user-password-to-default.input';
import {
  AdminResetUserPasswordResultDTO,
  toAdminResetUserPasswordResultDTO,
} from '@src/adapters/api/graphql/account/dto/admin-reset-user-password-result.dto';
import { AdminSetUserStatusInput } from '@src/adapters/api/graphql/account/dto/admin-set-user-status.input';
import { AdminUpdateUserProfileInput } from '@src/adapters/api/graphql/account/dto/admin-update-user-profile.input';
import { AdminUserDTO, toAdminUserDTO } from '@src/adapters/api/graphql/account/dto/admin-user.dto';
import { AdminUserListPageDTO } from '@src/adapters/api/graphql/account/dto/admin-user-list-page.dto';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { AdminCreateUserUsecase } from '@src/usecases/account/admin-create-user.usecase';
import { AdminResetUserPasswordUsecase } from '@src/usecases/account/admin-reset-user-password.usecase';
import { AdminResetUserPasswordToDefaultUsecase } from '@src/usecases/account/admin-reset-user-password-to-default.usecase';
import { AdminSetUserStatusUsecase } from '@src/usecases/account/admin-set-user-status.usecase';
import { AdminUpdateUserProfileUsecase } from '@src/usecases/account/admin-update-user-profile.usecase';
import { ListAdminUsersUsecase } from '@src/usecases/account/list-admin-users.usecase';

/**
 *
 * 职责边界（`docs/api/adapters.rules.md`）：
 * - 只做协议输入映射、Usecase 调用与 View → DTO 薄映射；业务规则、事务、
 *   目标保护、角色/状态白名单全部归 Usecase；
 * - 不依赖 modules(service)、QueryService、Repository 或 infrastructure；
 * - 错误不在此捕获：DomainError 直接上抛进入全局 GraphQL exception filter，
 *
 * - 粗粒度准入：`JwtAuthGuard` + `RolesGuard` + `@Roles(SUPER_ADMIN)`；
 * - 精确授权：每个 Usecase 继续执行请求期管理员作用域断言
 *   （`assertAdminUserManagementScope()` / `resolveLevelOneAdminScope()`，
 *   依请求期查库得到的 `adminLevel` 与可信公司归属裁决），
 *   Guard 不能替代 Usecase 的业务授权；
 * - 即时失效：停用 / 降级账号的旧 Token 由 `ValidateAccessTokenSessionUsecase`
 *   （P0-7）在每个受保护请求上复核。
 */
@Resolver()
export class AdminUserResolver {
  constructor(
    private readonly listAdminUsersUsecase: ListAdminUsersUsecase,
    private readonly adminCreateUserUsecase: AdminCreateUserUsecase,
    private readonly adminUpdateUserProfileUsecase: AdminUpdateUserProfileUsecase,
    private readonly adminSetUserStatusUsecase: AdminSetUserStatusUsecase,
    private readonly adminResetUserPasswordUsecase: AdminResetUserPasswordUsecase,
    private readonly adminResetUserPasswordToDefaultUsecase: AdminResetUserPasswordToDefaultUsecase,
  ) {}

  /**
   * 管理员分页查询用户列表（任务 08.4）。
   *
   * 只返回普通用户（ENGINEER / CUSTOMER），管理员账号不在读面输出；
   * 一级管理员全范围，二级管理员只在其请求期可信公司范围内筛选后再分页，
   * `total` 与 `items` 同源（范围下推到同一 QueryBuilder），不从总数泄漏外公司账号。
   * keyword 由 Usecase trim 后对登录名、登录邮箱、昵称做参数化模糊搜索；
   * role / status 缺省表示不按该维度筛选；排序由契约固定（created_at DESC, id DESC），
   * 不接受客户端排序字段。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminUserListPageDTO, { name: 'adminUsers', description: '管理员分页查询用户列表' })
  @ValidateInput()
  async adminUsers(
    @Args('pagination', { description: '分页参数' }) pagination: PaginationArgs,
    @currentUser() user: JwtPayload,
    @Args('keyword', {
      type: () => String,
      nullable: true,
      description: '关键字（登录名/登录邮箱/昵称模糊搜索）',
    })
    keyword?: string,
    @Args('role', {
      type: () => IdentityTypeEnum,
      nullable: true,
      description: '角色筛选（可筛选值域仅 ENGINEER / CUSTOMER）',
    })
    role?: IdentityTypeEnum,
    @Args('status', {
      type: () => AccountStatus,
      nullable: true,
      description: '状态筛选（可筛选值域仅 ACTIVE / INACTIVE）',
    })
    status?: AccountStatus,
  ): Promise<AdminUserListPageDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const page = await this.listAdminUsersUsecase.execute({
      session,
      pagination: mapGqlToCoreParams(pagination),
      keyword,
      role,
      status,
    });
    return {
      items: page.items.map((item) => toAdminUserDTO(item)),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  /**
   * 管理员创建 ENGINEER / CUSTOMER 用户（遗留入口，仅一级管理员）。
   *
   * 保留签名以兼容既有调用方，但 S4 管理页不再提供创建入口，二级管理员调用一律
   * `FORBIDDEN`（Usecase 内 `resolveLevelOneAdminScope()` 拒绝）。
   * 登录名 / 登录邮箱至少一个；创建固定为 ACTIVE；凭据唯一冲突对外为 CONFLICT。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => AdminUserDTO, { name: 'adminCreateUser', description: '管理员创建用户' })
  @ValidateInput()
  async adminCreateUser(
    @Args('input') input: AdminCreateUserInput,
    @currentUser() user: JwtPayload,
  ): Promise<AdminUserDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const view = await this.adminCreateUserUsecase.execute({
      session,
      loginName: input.loginName,
      loginEmail: input.loginEmail,
      loginPassword: input.initialPassword,
      role: input.role,
      nickname: input.nickname,
      companyName: input.companyName,
      phone: input.phone,
      contactEmail: input.contactEmail,
    });
    return toAdminUserDTO(view);
  }

  /**
   * 管理员编辑普通用户资料（昵称 / 公司名称 / 电话 / 联系邮箱）（遗留入口，仅一级管理员）。
   *
   * S4 管理页不再提供资料编辑入口；签名保留，二级管理员调用一律 `FORBIDDEN`。
   * 昵称不传 = 不修改、string = 修改且禁止 null / 空白；其余可选字段三态：
   * 不传 = 不修改，null = 清空。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => AdminUserDTO, {
    name: 'adminUpdateUserProfile',
    description: '管理员编辑普通用户资料',
  })
  @ValidateInput()
  async adminUpdateUserProfile(
    @Args('input') input: AdminUpdateUserProfileInput,
    @currentUser() user: JwtPayload,
  ): Promise<AdminUserDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const view = await this.adminUpdateUserProfileUsecase.execute({
      session,
      accountId: input.accountId,
      nickname: input.nickname,
      companyName: input.companyName,
      phone: input.phone,
      contactEmail: input.contactEmail,
    });
    return toAdminUserDTO(view);
  }

  /**
   * 管理员在 ACTIVE / INACTIVE 间切换状态（双字段同步由 Usecase 完成）。
   * 任何 SUPER_ADMIN 目标拒绝；管理员不能停用自己。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => AdminUserDTO, { name: 'adminSetUserStatus', description: '管理员设置用户状态' })
  @ValidateInput()
  async adminSetUserStatus(
    @Args('input') input: AdminSetUserStatusInput,
    @currentUser() user: JwtPayload,
  ): Promise<AdminUserDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const view = await this.adminSetUserStatusUsecase.execute({
      session,
      accountId: input.accountId,
      status: input.status,
    });
    return toAdminUserDTO(view);
  }

  /**
   * 管理员手动设置普通用户新密码（遗留入口，仅一级管理员）。
   *
   * 保留签名以兼容既有调用方；S4 管理页改用 `adminResetUserPasswordToDefault`
   * （不接受任意新密码），二级管理员调用本入口一律 `FORBIDDEN`。
   * 不走公开 verification token 流程；目标状态边界（仅双字段一致的
   * ACTIVE / INACTIVE）由 Usecase 在哈希生成与任何写入之前裁决。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => AdminResetUserPasswordResultDTO, {
    name: 'adminResetUserPassword',
    description: '管理员重置普通用户密码',
  })
  @ValidateInput()
  async adminResetUserPassword(
    @Args('input') input: AdminResetUserPasswordInput,
    @currentUser() user: JwtPayload,
  ): Promise<AdminResetUserPasswordResultDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const result = await this.adminResetUserPasswordUsecase.execute({
      session,
      accountId: input.accountId,
      newPassword: input.newPassword,
    });
    return toAdminResetUserPasswordResultDTO(result);
  }

  /**
   * 管理员把普通用户密码重置为系统默认密码（任务 08.4）。
   *
   * - 输入只有目标 `accountId`：默认密码来自服务端配置，不接受客户端密码；
   * - 一级管理员全范围，二级管理员仅可信公司内目标；管理员账号只读；
   * - 写入哈希的同一条 UPDATE 置 `must_change_password = true`，目标用户下次登录
   *   必须先改密；配置缺失或不合策略时失败关闭，不回退硬编码口令；
   * - 回包只含固定安全提示，不含密码。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => AdminResetUserPasswordResultDTO, {
    name: 'adminResetUserPasswordToDefault',
    description: '管理员重置普通用户密码为系统默认密码',
  })
  @ValidateInput()
  async adminResetUserPasswordToDefault(
    @Args('input') input: AdminResetUserPasswordToDefaultInput,
    @currentUser() user: JwtPayload,
  ): Promise<AdminResetUserPasswordResultDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const result = await this.adminResetUserPasswordToDefaultUsecase.execute({
      session,
      accountId: input.accountId,
    });
    return toAdminResetUserPasswordResultDTO(result);
  }
}
