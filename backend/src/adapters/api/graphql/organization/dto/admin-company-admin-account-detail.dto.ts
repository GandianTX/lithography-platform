// src/adapters/api/graphql/organization/dto/admin-company-admin-account-detail.dto.ts

import { Field, Int, ObjectType } from '@nestjs/graphql';
import {
  organizationStatusValues,
  type OrganizationStatus,
} from '@src/modules/lithography/organization.types';
import type { CompanyAdminAccountDetailView } from '@src/usecases/organization/company-admin-binding.types';

/**
 * 一级管理员按公司查询二级管理员账号详情（D 组窄查询）。
 *
 * 与 `adminCompanyAdminBinding` 的摘要口径分开：本查询只在公司存在**唯一合法绑定**
 * 时返回完整登录名与是否待首次改密；冲突 / 未绑 / 公司停用只返回状态与归属提示，
 * `accountId` / `loginName` / `nickname` / `mustChangePassword` 一律为 null。
 *
 * 不含任何口令、密码哈希或凭据字段。
 */
@ObjectType({ description: '公司二级管理员账号详情（一级管理员；无凭据字段）' })
export class AdminCompanyAdminAccountDetailDTO {
  @Field(() => Int, { description: '公司主键' })
  organizationId!: number;

  @Field(() => String, { description: '公司编号' })
  organizationCode!: string;

  @Field(() => String, { description: '公司全称' })
  companyName!: string;

  @Field(() => Boolean, { description: '是否属于一级维护名单（受管公司）' })
  isManagedCompany!: boolean;

  @Field(() => organizationStatusValues, {
    description: '公司状态：ACTIVE=启用 / DISABLED=停用',
  })
  companyStatus!: OrganizationStatus;

  @Field(() => String, {
    description: '绑定状态：BOUND / UNCONFIGURED / CONFLICT / COMPANY_DISABLED',
  })
  status!: string;

  @Field(() => String, { nullable: true, description: '冲突原因；非冲突为空' })
  reason?: string | null;

  @Field(() => Int, {
    nullable: true,
    description: '唯一合法绑定账号主键；未绑定、冲突或停用为空',
  })
  accountId?: number | null;

  @Field(() => String, {
    nullable: true,
    description: '完整登录名；仅唯一合法绑定时返回，其余状态为空',
  })
  loginName?: string | null;

  @Field(() => String, { nullable: true, description: '账号昵称；仅唯一合法绑定时返回' })
  nickname?: string | null;

  @Field(() => Boolean, {
    nullable: true,
    description: '是否仍待首次改密；仅唯一合法绑定时返回，其余状态为空',
  })
  mustChangePassword?: boolean | null;

  @Field(() => Boolean, { description: '绑定账号是否已停用（账号或资料任一停用即为 true）' })
  accountDisabled!: boolean;

  @Field(() => Int, { description: '候选账号数量（0 表示未配置）' })
  candidateCount!: number;
}

/** View → DTO 薄映射 */
export function toAdminCompanyAdminAccountDetailDTO(
  view: CompanyAdminAccountDetailView,
): AdminCompanyAdminAccountDetailDTO {
  return {
    organizationId: view.organizationId,
    organizationCode: view.organizationCode,
    companyName: view.companyName,
    isManagedCompany: view.isManagedCompany,
    companyStatus: view.companyStatus,
    status: view.status,
    reason: view.reason,
    accountId: view.accountId,
    loginName: view.loginName,
    nickname: view.nickname,
    mustChangePassword: view.mustChangePassword,
    accountDisabled: view.accountDisabled,
    candidateCount: view.candidateCount,
  };
}
