// src/adapters/api/graphql/organization/dto/admin-organization.dto.ts

import { Field, Int, ObjectType } from '@nestjs/graphql';
import {
  organizationKindValues,
  organizationStatusValues,
  type AdminOrganizationPage,
  type AdminOrganizationView,
  type OrganizationKind,
  type OrganizationStatus,
} from '@src/modules/lithography/organization.types';
import type { ProvisionedAdminSummary } from '@src/usecases/organization/company-provisioning.types';

/**
 * 已开通二级管理员的安全摘要。
 *
 * 只含账号主键、登录名、昵称与「必须先改密」标记；**绝不包含**临时密码、
 * 密码哈希或任何令牌。临时密码只经 `AdminCompanyProvisioningResultDTO` 根字段
 * 一次性返回。
 */
@ObjectType({ description: '已开通的二级管理员（安全摘要，不含凭据）' })
export class ProvisionedAdminDTO {
  @Field(() => Int, { description: '管理员账号主键' })
  accountId!: number;

  @Field(() => String, { description: '服务端生成的稳定登录名（非联系邮箱）' })
  loginName!: string;

  @Field(() => String, { description: '默认昵称（取自公司全称）' })
  nickname!: string;

  @Field(() => Boolean, { description: '是否必须首登改密（恒为 true）' })
  mustChangePassword!: boolean;
}

/** 已开通管理员摘要 → DTO 薄映射 */
export function toProvisionedAdminDTO(admin: ProvisionedAdminSummary): ProvisionedAdminDTO {
  return {
    accountId: admin.accountId,
    loginName: admin.loginName,
    nickname: admin.nickname,
    mustChangePassword: admin.mustChangePassword,
  };
}

/**
 * 一级管理员公司档案完整视图（任务 08.2）。
 *
 * 含编号、联系信息、状态、受管归类与维修资格；只对一级管理员开放，
 * 二级管理员只能读取最小名称名单（`AdminOrganizationNameDTO`）。
 */
@ObjectType({ description: '管理员公司档案（完整字段）' })
export class AdminOrganizationDTO {
  @Field(() => Int, { description: '公司主键' })
  id!: number;

  @Field(() => String, { description: '公司编号（服务端生成，只读）' })
  organizationCode!: string;

  @Field(() => String, { description: '公司全称' })
  name!: string;

  @Field(() => String, { nullable: true, description: '公司简称' })
  shortName?: string | null;

  @Field(() => String, { nullable: true, description: '联系人姓名' })
  contactName?: string | null;

  @Field(() => String, { nullable: true, description: '联系电话' })
  contactPhone?: string | null;

  @Field(() => String, { nullable: true, description: '公司邮箱' })
  contactEmail?: string | null;

  @Field(() => String, { nullable: true, description: '地址' })
  address?: string | null;

  @Field(() => String, { nullable: true, description: '备注' })
  remark?: string | null;

  @Field(() => Boolean, { description: '是否提供维修服务' })
  isServiceProvider!: boolean;

  @Field(() => Boolean, { description: '是否属于一级维护名单（受管公司）' })
  isManagedCompany!: boolean;

  @Field(() => organizationKindValues, { description: '公司类别：CLIENT=甲方 / PEER=同行' })
  kind!: OrganizationKind;

  @Field(() => organizationStatusValues, {
    description: '公司状态：ACTIVE=启用 / DISABLED=停用',
  })
  status!: OrganizationStatus;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;

  @Field(() => Date, { description: '最近更新时间' })
  updatedAt!: Date;

  /**
   * 本次写后附带的开通管理员摘要。
   *
   * 仅「新增公司并开通管理员」的写后返回会填充，其余读取路径恒为 `null`；
   * 供旧合同 `adminCreateOrganization` 的调用方登记新账号归属。
   */
  @Field(() => ProvisionedAdminDTO, {
    nullable: true,
    description: '本次开通的二级管理员摘要；仅写后返回填充',
  })
  provisionedAdmin?: ProvisionedAdminDTO | null;
}

/** 管理员公司档案分页结果 */
@ObjectType({ description: '管理员公司档案分页结果（按名称、主键升序）' })
export class AdminOrganizationPageDTO {
  @Field(() => [AdminOrganizationDTO], { description: '当前页公司' })
  items!: AdminOrganizationDTO[];

  @Field(() => Int, { description: '符合条件的总数' })
  total!: number;

  @Field(() => Int, { description: '当前页码（从 1 开始）' })
  page!: number;

  @Field(() => Int, { description: '页大小' })
  pageSize!: number;
}

/**
 * View → DTO 薄映射（字段直通，不做业务判断）。
 *
 * 第二个参数仅用于「新增公司并开通管理员」的写后返回；读取路径不传，
 * `provisionedAdmin` 恒为 `null`。
 */
export function toAdminOrganizationDTO(
  view: AdminOrganizationView,
  provisionedAdmin?: ProvisionedAdminSummary | null,
): AdminOrganizationDTO {
  return {
    id: view.id,
    organizationCode: view.organizationCode,
    name: view.name,
    shortName: view.shortName,
    contactName: view.contactName,
    contactPhone: view.contactPhone,
    contactEmail: view.contactEmail,
    address: view.address,
    remark: view.remark,
    isServiceProvider: view.isServiceProvider,
    isManagedCompany: view.isManagedCompany,
    kind: view.kind,
    status: view.status,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    provisionedAdmin: provisionedAdmin ? toProvisionedAdminDTO(provisionedAdmin) : null,
  };
}

export function toAdminOrganizationPageDTO(page: AdminOrganizationPage): AdminOrganizationPageDTO {
  return {
    items: page.items.map((item) => toAdminOrganizationDTO(item)),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
  };
}
