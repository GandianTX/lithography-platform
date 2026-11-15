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

/** View → DTO 薄映射（字段直通，不做业务判断） */
export function toAdminOrganizationDTO(view: AdminOrganizationView): AdminOrganizationDTO {
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
  };
}

export function toAdminOrganizationPageDTO(page: AdminOrganizationPage): AdminOrganizationPageDTO {
  return {
    items: page.items.map(toAdminOrganizationDTO),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
  };
}
