// src/adapters/api/graphql/organization/organization-admin.resolver.ts

import { ValidateInput } from '@adapters/api/graphql/common/validate-input.decorator';
import { mapJwtToUsecaseSession } from '@app-types/auth/session.types';
import type { AuthenticatedSessionUser } from '@app-types/auth/session-restriction.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { UseGuards } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { mapGqlToCoreParams } from '@src/adapters/api/graphql/pagination.mapper';
import { PaginationArgs } from '@src/adapters/api/graphql/pagination.args';
import { organizationStatusValues } from '@src/modules/lithography/organization.types';
import { CheckAdminOrganizationNameUsecase } from '@src/usecases/organization/check-admin-organization-name.usecase';
import { CreateAdminOrganizationUsecase } from '@src/usecases/organization/create-admin-organization.usecase';
import { GetAdminCompanyAdminAccountDetailUsecase } from '@src/usecases/organization/get-admin-company-admin-account-detail.usecase';
import { GetAdminCompanyAdminBindingUsecase } from '@src/usecases/organization/get-admin-company-admin-binding.usecase';
import { GetAdminOrganizationDetailUsecase } from '@src/usecases/organization/get-admin-organization-detail.usecase';
import { ListAdminOrganizationNamesUsecase } from '@src/usecases/organization/list-admin-organization-names.usecase';
import { ListAdminOrganizationsUsecase } from '@src/usecases/organization/list-admin-organizations.usecase';
import { ListBoundLevelTwoAdminsUsecase } from '@src/usecases/organization/list-bound-level-two-admins.usecase';
import { ProvisionCompanyWithAdminUsecase } from '@src/usecases/organization/provision-company-with-admin.usecase';
import { ReissueLevelTwoCredentialUsecase } from '@src/usecases/organization/reissue-level-two-credential.usecase';
import { ResetLevelTwoCredentialUsecase } from '@src/usecases/organization/reset-level-two-credential.usecase';
import { UpdateAdminOrganizationUsecase } from '@src/usecases/organization/update-admin-organization.usecase';
import { AdminCreateOrganizationInput } from './dto/admin-create-organization.input';
import {
  AdminBoundLevelTwoAdminPageDTO,
  toAdminBoundLevelTwoAdminPageDTO,
} from './dto/admin-bound-level-two-admin.dto';
import {
  AdminCompanyAdminAccountDetailDTO,
  toAdminCompanyAdminAccountDetailDTO,
} from './dto/admin-company-admin-account-detail.dto';
import {
  AdminCompanyAdminBindingDTO,
  toAdminCompanyAdminBindingDTO,
} from './dto/admin-company-admin-binding.dto';
import {
  AdminLevelTwoCredentialResultDTO,
  toAdminLevelTwoCredentialResultDTO,
} from './dto/admin-level-two-credential-result.dto';
import { AdminReissueLevelTwoCredentialInput } from './dto/admin-reissue-level-two-credential.input';
import { AdminResetLevelTwoCredentialInput } from './dto/admin-reset-level-two-credential.input';
import {
  AdminCompanyProvisioningResultDTO,
  toAdminCompanyProvisioningResultDTO,
} from './dto/admin-company-provisioning-result.dto';
import {
  AdminOrganizationNamePageDTO,
  toAdminOrganizationNamePageDTO,
} from './dto/admin-organization-name.dto';
import {
  AdminOrganizationDTO,
  AdminOrganizationPageDTO,
  toAdminOrganizationDTO,
  toAdminOrganizationPageDTO,
} from './dto/admin-organization.dto';
import { AdminUpdateOrganizationInput } from './dto/admin-update-organization.input';

/**
 * 管理员公司档案解析器（任务 08.2）。
 *
 * 入口分两类：
 * - 一级管理员完整读写：`adminOrganizationList` / `adminOrganizationDetail` /
 *   `adminCreateOrganization` / `adminUpdateOrganization`；
 * - 一、二级共用最小名称名单：`adminOrganizationNameList`（S1 已有）。
 *
 * 授权真源在服务端：守卫只做 `SUPER_ADMIN` 粗粒度准入，一级/二级判定与可信公司归属
 * 由用例按请求期会话事实裁决，不信任任何客户端身份变量。本解析器只做参数映射与
 * 用例调用，不含业务判断。
 */
@Resolver()
export class OrganizationAdminResolver {
  constructor(
    private readonly listAdminOrganizationNamesUsecase: ListAdminOrganizationNamesUsecase,
    private readonly listAdminOrganizationsUsecase: ListAdminOrganizationsUsecase,
    private readonly getAdminOrganizationDetailUsecase: GetAdminOrganizationDetailUsecase,
    private readonly createAdminOrganizationUsecase: CreateAdminOrganizationUsecase,
    private readonly provisionCompanyWithAdminUsecase: ProvisionCompanyWithAdminUsecase,
    private readonly updateAdminOrganizationUsecase: UpdateAdminOrganizationUsecase,
    private readonly checkAdminOrganizationNameUsecase: CheckAdminOrganizationNameUsecase,
    private readonly getAdminCompanyAdminBindingUsecase: GetAdminCompanyAdminBindingUsecase,
    private readonly getAdminCompanyAdminAccountDetailUsecase: GetAdminCompanyAdminAccountDetailUsecase,
    private readonly listBoundLevelTwoAdminsUsecase: ListBoundLevelTwoAdminsUsecase,
    private readonly reissueLevelTwoCredentialUsecase: ReissueLevelTwoCredentialUsecase,
    private readonly resetLevelTwoCredentialUsecase: ResetLevelTwoCredentialUsecase,
  ) {}

  /**
   * 管理员公司名称名单（一级全范围、二级跨公司只读最小字段）。
   *
   * 仅返回 `id` / `name`；关键字按名称子串过滤，分页仅支持 OFFSET。
   * 等级缺失/非法或二级缺少可信公司时由用例统一拒绝（`FORBIDDEN`）。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminOrganizationNamePageDTO, {
    name: 'adminOrganizationNameList',
    description: '管理员公司名称名单（最小字段；一级全范围、二级跨公司只读）',
  })
  @ValidateInput()
  async adminOrganizationNameList(
    @Args('pagination', { description: '分页参数（仅 OFFSET）' }) pagination: PaginationArgs,
    @currentUser() user: AuthenticatedSessionUser,
    @Args('keyword', {
      type: () => String,
      nullable: true,
      description: '公司名称关键字；缺省表示不过滤',
    })
    keyword?: string,
  ): Promise<AdminOrganizationNamePageDTO> {
    const page = await this.listAdminOrganizationNamesUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      keyword: keyword ?? null,
      pagination: mapGqlToCoreParams(pagination),
    });
    return toAdminOrganizationNamePageDTO(page);
  }

  /**
   * 一级管理员公司档案列表：关键字匹配全称/编号/简称，可按状态、受管归类、
   * 维修资格筛选；分页仅支持 OFFSET，页大小上限 50。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminOrganizationPageDTO, {
    name: 'adminOrganizationList',
    description: '公司档案列表（一级管理员；含停用公司与筛选）',
  })
  @ValidateInput()
  async adminOrganizationList(
    @Args('pagination', { description: '分页参数（仅 OFFSET）' }) pagination: PaginationArgs,
    @currentUser() user: AuthenticatedSessionUser,
    @Args('keyword', {
      type: () => String,
      nullable: true,
      description: '关键字（匹配全称/编号/简称）；缺省表示不过滤',
    })
    keyword?: string,
    @Args('status', {
      type: () => organizationStatusValues,
      nullable: true,
      description: '公司状态筛选；缺省表示不过滤',
    })
    status?: string,
    @Args('isManagedCompany', {
      type: () => Boolean,
      nullable: true,
      description: '是否属于一级维护名单；缺省表示不过滤',
    })
    isManagedCompany?: boolean,
    @Args('isServiceProvider', {
      type: () => Boolean,
      nullable: true,
      description: '是否提供维修服务；缺省表示不过滤',
    })
    isServiceProvider?: boolean,
  ): Promise<AdminOrganizationPageDTO> {
    const page = await this.listAdminOrganizationsUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      keyword: keyword ?? null,
      status: status ?? null,
      isManagedCompany: isManagedCompany ?? null,
      isServiceProvider: isServiceProvider ?? null,
      pagination: mapGqlToCoreParams(pagination),
    });
    return toAdminOrganizationPageDTO(page);
  }

  /** 一级管理员公司档案详情（含停用公司；不存在统一 NOT_FOUND） */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminOrganizationDTO, {
    name: 'adminOrganizationDetail',
    description: '公司档案详情（一级管理员）',
  })
  @ValidateInput()
  async adminOrganizationDetail(
    @Args('organizationId', { type: () => Int, description: '公司主键' })
    organizationId: number,
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<AdminOrganizationDTO> {
    const view = await this.getAdminOrganizationDetailUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      organizationId,
    });
    return toAdminOrganizationDTO(view);
  }

  /**
   * 一级管理员精确同名提示：覆盖全部公司档案（含停用与未受管），编辑时可排除自身。
   *
   * 只返回布尔提示，不阻断新增，也不改变「同名不合并」的写入语义；
   * 公开注册的「启用且受管」口径仍由 `registrationOrganizationNameExists` 服务。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => Boolean, {
    name: 'adminOrganizationNameExists',
    description: '公司全称精确同名提示（一级管理员；含停用与未受管档案）',
  })
  @ValidateInput()
  async adminOrganizationNameExists(
    @Args('name', {
      type: () => String,
      description: '公司全称；按去首尾空白、合并连续空白、忽略大小写后精确比较',
    })
    name: string,
    @currentUser() user: AuthenticatedSessionUser,
    @Args('excludeOrganizationId', {
      type: () => Int,
      nullable: true,
      description: '编辑场景排除的自身主键；新增不传',
    })
    excludeOrganizationId?: number,
  ): Promise<boolean> {
    return this.checkAdminOrganizationNameUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      name,
      excludeOrganizationId: excludeOrganizationId ?? null,
    });
  }

  /**
   * 一级管理员按公司 ID 查询二级管理员绑定（S3）。
   *
   * 公司不存在统一 `NOT_FOUND`；非受管公司返回 `UNCONFIGURED` 安全状态；
   * 冲突与停用只给状态、原因与脱敏登录名。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminCompanyAdminBindingDTO, {
    name: 'adminCompanyAdminBinding',
    description: '按公司查询二级管理员绑定（一级管理员；无凭据字段）',
  })
  @ValidateInput()
  async adminCompanyAdminBinding(
    @Args('organizationId', { type: () => Int, description: '公司主键' })
    organizationId: number,
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<AdminCompanyAdminBindingDTO> {
    const view = await this.getAdminCompanyAdminBindingUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      organizationId,
    });
    return toAdminCompanyAdminBindingDTO(view);
  }

  /**
   * 一级管理员按公司 ID 查询二级管理员账号详情（D 组按需窄查询）。
   *
   * 仅唯一合法绑定时返回完整登录名、昵称与「是否待首次改密」；
   * 冲突 / 未绑 / 停用只返回状态与归属提示，不猜测账号、不输出凭据。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminCompanyAdminAccountDetailDTO, {
    name: 'adminCompanyAdminAccountDetail',
    description:
      '按公司查询二级管理员账号详情（一级管理员；唯一合法绑定时返回完整登录名与开通状态）',
  })
  @ValidateInput()
  async adminCompanyAdminAccountDetail(
    @Args('organizationId', { type: () => Int, description: '公司主键' })
    organizationId: number,
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<AdminCompanyAdminAccountDetailDTO> {
    const view = await this.getAdminCompanyAdminAccountDetailUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      organizationId,
    });
    return toAdminCompanyAdminAccountDetailDTO(view);
  }

  /**
   * 一级管理员「已绑定二级管理员」列表（S3 用户管理选择器）。
   *
   * 只列 `BOUND` 绑定；关键字匹配公司全称/编号/登录名/昵称。
   * 受管公司超过在线盘点上限时显式失败，不静默截断。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminBoundLevelTwoAdminPageDTO, {
    name: 'adminBoundLevelTwoAdmins',
    description: '已绑定二级管理员列表（一级管理员；只含合法绑定）',
  })
  @ValidateInput()
  async adminBoundLevelTwoAdmins(
    @Args('pagination', { description: '分页参数（仅 OFFSET）' }) pagination: PaginationArgs,
    @currentUser() user: AuthenticatedSessionUser,
    @Args('keyword', {
      type: () => String,
      nullable: true,
      description: '关键字（公司全称/编号/登录名/昵称）；缺省表示不过滤',
    })
    keyword?: string,
  ): Promise<AdminBoundLevelTwoAdminPageDTO> {
    const page = await this.listBoundLevelTwoAdminsUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      keyword: keyword ?? null,
      pagination: mapGqlToCoreParams(pagination),
    });
    return toAdminBoundLevelTwoAdminPageDTO(page);
  }

  /**
   * 一级管理员新增公司档案：服务端生成编号，强制进入受管名单，状态按入参
   * （缺省 `ACTIVE`），维修资格可按入参设置。提交后在同一事务内回读返回真实落库结果。
   *
   * 旧合同入口：不传 `submissionKey` 时不写提交行（无幂等路径），但仍在**同一事务**
   * 内完成公司与二级管理员的开通；返回附带 `provisionedAdmin` 摘要供调用方登记。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => AdminOrganizationDTO, {
    name: 'adminCreateOrganization',
    description: '新增公司档案（一级管理员；编号服务端生成、强制受管）',
  })
  @ValidateInput()
  async adminCreateOrganization(
    @Args('input', { type: () => AdminCreateOrganizationInput })
    input: AdminCreateOrganizationInput,
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<AdminOrganizationDTO> {
    const result = await this.createAdminOrganizationUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      name: input.name,
      contactPhone: input.contactPhone,
      shortName: input.shortName,
      contactName: input.contactName,
      contactEmail: input.contactEmail,
      address: input.address,
      remark: input.remark,
      status: input.status,
      isServiceProvider: input.isServiceProvider,
      submissionKey: input.submissionKey,
    });
    return toAdminOrganizationDTO(result.organization, result.admin);
  }

  /**
   * 一级管理员新增公司并开通二级管理员（新合同，带提交标识幂等）。
   *
   * 与旧入口的差异：`submissionKey` 必填（缺失由用例拒绝），结果含提交标识
   * 结果与一次性临时密码；同标识同输入回放返回相同公司与账号，且永不返回口令。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => AdminCompanyProvisioningResultDTO, {
    name: 'adminProvisionCompany',
    description: '新增公司并开通二级管理员（一级管理员；提交标识幂等）',
  })
  @ValidateInput()
  async adminProvisionCompany(
    @Args('input', { type: () => AdminCreateOrganizationInput })
    input: AdminCreateOrganizationInput,
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<AdminCompanyProvisioningResultDTO> {
    const result = await this.provisionCompanyWithAdminUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      name: input.name,
      contactPhone: input.contactPhone,
      shortName: input.shortName,
      contactName: input.contactName,
      contactEmail: input.contactEmail,
      address: input.address,
      remark: input.remark,
      status: input.status,
      isServiceProvider: input.isServiceProvider,
      submissionKey: input.submissionKey ?? null,
    });
    return toAdminCompanyProvisioningResultDTO(result);
  }

  /**
   * 一级管理员编辑公司档案：只写白名单字段；未传字段保持不变，可选文本显式
   * `null` / 空白为清空；编号与受管归类不可改；启停与维修资格分别更新。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => AdminOrganizationDTO, {
    name: 'adminUpdateOrganization',
    description: '编辑公司档案（一级管理员；白名单字段，含启停与维修资格）',
  })
  @ValidateInput()
  async adminUpdateOrganization(
    @Args('input', { type: () => AdminUpdateOrganizationInput })
    input: AdminUpdateOrganizationInput,
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<AdminOrganizationDTO> {
    const view = await this.updateAdminOrganizationUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      organizationId: input.organizationId,
      name: input.name,
      contactPhone: input.contactPhone,
      shortName: input.shortName,
      contactName: input.contactName,
      contactEmail: input.contactEmail,
      address: input.address,
      remark: input.remark,
      status: input.status,
      isServiceProvider: input.isServiceProvider,
    });
    return toAdminOrganizationDTO(view);
  }

  /**
   * 一级管理员补发二级管理员临时密码（S3）。
   *
   * 只允许尚待首次改密的目标；已改密、错绑、无绑、冲突、公司停用或账号停用
   * 一律拒绝。成功后返回新随机临时密码，旧口令与旧 access token 即刻失效。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => AdminLevelTwoCredentialResultDTO, {
    name: 'adminReissueCompanyAdminCredential',
    description: '补发二级管理员临时密码（一级管理员；仅限待首次改密目标）',
  })
  @ValidateInput()
  async adminReissueCompanyAdminCredential(
    @Args('input', { type: () => AdminReissueLevelTwoCredentialInput })
    input: AdminReissueLevelTwoCredentialInput,
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<AdminLevelTwoCredentialResultDTO> {
    const result = await this.reissueLevelTwoCredentialUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      organizationId: input.organizationId,
    });
    return toAdminLevelTwoCredentialResultDTO(result);
  }

  /**
   * 一级管理员二级专用重置（S3）。
   *
   * 允许对已首次改密的合法目标重新开通，但必须提供原因并写入审计。
   * 组织与账号必须同时命中同一唯一合法绑定。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => AdminLevelTwoCredentialResultDTO, {
    name: 'adminResetLevelTwoAdminCredential',
    description: '二级管理员密码重置（一级管理员；必填原因并写审计）',
  })
  @ValidateInput()
  async adminResetLevelTwoAdminCredential(
    @Args('input', { type: () => AdminResetLevelTwoCredentialInput })
    input: AdminResetLevelTwoCredentialInput,
    @currentUser() user: AuthenticatedSessionUser,
  ): Promise<AdminLevelTwoCredentialResultDTO> {
    const result = await this.resetLevelTwoCredentialUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      organizationId: input.organizationId,
      adminAccountId: input.adminAccountId,
      reason: input.reason,
    });
    return toAdminLevelTwoCredentialResultDTO(result);
  }
}
