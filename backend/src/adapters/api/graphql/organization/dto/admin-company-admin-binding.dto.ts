// src/adapters/api/graphql/organization/dto/admin-company-admin-binding.dto.ts

import { Field, Int, ObjectType } from '@nestjs/graphql';
import {
  organizationStatusValues,
  type OrganizationStatus,
} from '@src/modules/lithography/organization.types';
import type { CompanyAdminBindingView } from '@src/usecases/organization/company-admin-binding.types';

/**
 * 一级管理员按公司查询的二级管理员绑定状态（S3）。
 *
 * 不含任何凭据字段；完整登录名只留在服务端，`boundLoginNameMasked` 是唯一
 * 对外登录名形态。`status` 取值：
 * `BOUND` / `UNCONFIGURED` / `CONFLICT` / `COMPANY_DISABLED`；
 * `reason` 仅冲突时有值（如 `MULTIPLE_BINDINGS` / `LEVEL_MISMATCH` 等）。
 */
@ObjectType({ description: '公司二级管理员绑定状态（一级管理员；无凭据字段）' })
export class AdminCompanyAdminBindingDTO {
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

  @Field(() => Int, { nullable: true, description: '唯一合法绑定账号主键；未绑定或冲突为空' })
  boundAccountId?: number | null;

  @Field(() => String, { nullable: true, description: '脱敏登录名（完整登录名不对外输出）' })
  boundLoginNameMasked?: string | null;

  @Field(() => Int, { description: '候选账号数量（0 表示未配置）' })
  candidateCount!: number;

  @Field(() => Boolean, { description: '绑定账号是否已停用（账号或资料任一停用即为 true）' })
  accountDisabled!: boolean;
}

/** View → DTO 薄映射 */
export function toAdminCompanyAdminBindingDTO(
  view: CompanyAdminBindingView,
): AdminCompanyAdminBindingDTO {
  return {
    organizationId: view.organizationId,
    organizationCode: view.organizationCode,
    companyName: view.companyName,
    isManagedCompany: view.isManagedCompany,
    companyStatus: view.companyStatus,
    status: view.status,
    reason: view.reason,
    boundAccountId: view.boundAccountId,
    boundLoginNameMasked: view.boundLoginNameMasked,
    candidateCount: view.candidateCount,
    accountDisabled: view.accountDisabled,
  };
}
