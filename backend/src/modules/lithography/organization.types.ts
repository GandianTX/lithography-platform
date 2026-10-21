// src/modules/lithography/organization.types.ts

import type { IdentityTypeEnum } from '@app-types/models/account.types';

/**
 * 组织领域稳定视图与事实类型（不暴露 ORM Entity）。
 */

/**
 * 组织成员事实：可信组织上下文解析与成员校验的唯一输入事实。
 *
 * 仅表达「有效」关系：成员状态 ACTIVE 且所属组织状态 ACTIVE
 * （过滤口径由 OrganizationMembershipQueryService 统一保证）。
 * 组织名称/编码来自组织表事实，不取账号 `company_name` 等自报字段。
 */
export type OrganizationMembershipFact = {
  /** 成员关系主键 */
  membershipId: number;
  /** 组织主键 */
  organizationId: number;
  /** 组织业务编码（如 `CLIENT_DEFAULT`） */
  organizationCode: string;
  /** 组织名称（展示用） */
  organizationName: string;
  /** 组织类别：`CLIENT`=甲方；`PEER`=同行 */
  organizationKind: string;
  /** 组织内角色：`SUPER_ADMIN`=组织管理员；`ENGINEER`=工程师 */
  memberRole: string;
};

/**
 * 组织成员关系写入数据（A-PR0 §4.3：管理员创建账号时同事务绑定的唯一入口形态）。
 *
 * `memberRole` 与实体 `chk_organization_membership_role` 值域一致；
 * 本期唯一写路径固定写入 `ENGINEER`（管理员仅在创建工程师时绑定其当前有效组织，
 * 客户不自动加入）。
 */
export type OrganizationMembershipInsertData = {
  /** 组织主键（来自可信组织上下文解析，绝不取客户端自报） */
  organizationId: number;
  /** 账号主键（同一事务内刚创建的账号） */
  accountId: number;
  /** 组织内角色：`SUPER_ADMIN`=组织管理员；`ENGINEER`=工程师 */
  memberRole: IdentityTypeEnum.SUPER_ADMIN | IdentityTypeEnum.ENGINEER;
};
