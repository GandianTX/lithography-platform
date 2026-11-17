// src/adapters/api/graphql/organization/dto/admin-bound-level-two-admin.dto.ts

import { Field, Int, ObjectType } from '@nestjs/graphql';
import {
  organizationStatusValues,
  type OrganizationStatus,
} from '@src/modules/lithography/organization.types';
import type {
  BoundLevelTwoAdminPage,
  BoundLevelTwoAdminView,
} from '@src/usecases/organization/company-admin-binding.types';

/**
 * 「已绑定二级管理员」列表项（一级专用用户管理选择器）。
 *
 * 只列出绑定状态为 `BOUND` 的公司；`accountDisabled=true` 时前端应禁用选择
 * （补发/重置会拒绝账号停用的目标）。
 */
@ObjectType({ description: '已绑定二级管理员（一级专用列表项）' })
export class AdminBoundLevelTwoAdminDTO {
  @Field(() => Int, { description: '公司主键' })
  organizationId!: number;

  @Field(() => String, { description: '公司编号' })
  organizationCode!: string;

  @Field(() => String, { description: '公司全称' })
  companyName!: string;

  @Field(() => organizationStatusValues, { description: '公司状态' })
  companyStatus!: OrganizationStatus;

  @Field(() => Int, { description: '绑定管理员账号主键' })
  accountId!: number;

  @Field(() => String, { description: '登录名（供一级管理员定位与选择目标）' })
  loginName!: string;

  @Field(() => String, { nullable: true, description: '昵称' })
  nickname?: string | null;

  @Field(() => Boolean, { description: '账号是否已停用；true 时不可补发/重置' })
  accountDisabled!: boolean;
}

/** 已绑定二级管理员分页结果 */
@ObjectType({ description: '已绑定二级管理员分页结果' })
export class AdminBoundLevelTwoAdminPageDTO {
  @Field(() => [AdminBoundLevelTwoAdminDTO], { description: '当前页' })
  items!: AdminBoundLevelTwoAdminDTO[];

  @Field(() => Int, { description: '符合条件的总数' })
  total!: number;

  @Field(() => Int, { description: '当前页码（从 1 开始）' })
  page!: number;

  @Field(() => Int, { description: '页大小' })
  pageSize!: number;
}

export function toAdminBoundLevelTwoAdminDTO(
  view: BoundLevelTwoAdminView,
): AdminBoundLevelTwoAdminDTO {
  return {
    organizationId: view.organizationId,
    organizationCode: view.organizationCode,
    companyName: view.companyName,
    companyStatus: view.companyStatus,
    accountId: view.accountId,
    loginName: view.loginName,
    nickname: view.nickname,
    accountDisabled: view.accountDisabled,
  };
}

export function toAdminBoundLevelTwoAdminPageDTO(
  page: BoundLevelTwoAdminPage,
): AdminBoundLevelTwoAdminPageDTO {
  return {
    items: page.items.map((item) => toAdminBoundLevelTwoAdminDTO(item)),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
  };
}
