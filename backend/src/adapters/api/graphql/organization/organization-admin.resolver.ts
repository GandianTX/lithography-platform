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
import { CreateAdminOrganizationUsecase } from '@src/usecases/organization/create-admin-organization.usecase';
import { GetAdminOrganizationDetailUsecase } from '@src/usecases/organization/get-admin-organization-detail.usecase';
import { ListAdminOrganizationNamesUsecase } from '@src/usecases/organization/list-admin-organization-names.usecase';
import { ListAdminOrganizationsUsecase } from '@src/usecases/organization/list-admin-organizations.usecase';
import { UpdateAdminOrganizationUsecase } from '@src/usecases/organization/update-admin-organization.usecase';
import { AdminCreateOrganizationInput } from './dto/admin-create-organization.input';
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
    private readonly updateAdminOrganizationUsecase: UpdateAdminOrganizationUsecase,
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
   * 一级管理员新增公司档案：服务端生成编号，强制进入受管名单，初始 `ACTIVE`，
   * 维修资格可按入参设置。提交后在同一事务内回读返回真实落库结果。
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
    const view = await this.createAdminOrganizationUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      name: input.name,
      contactPhone: input.contactPhone,
      shortName: input.shortName,
      contactName: input.contactName,
      contactEmail: input.contactEmail,
      address: input.address,
      remark: input.remark,
      isServiceProvider: input.isServiceProvider,
    });
    return toAdminOrganizationDTO(view);
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
}
