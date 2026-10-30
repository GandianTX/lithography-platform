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
  /** 组织内角色：`SUPER_ADMIN`=组织管理员；`ENGINEER`=工程师；`CUSTOMER`=客户 */
  memberRole: string;
};

/**
 * 组织成员关系写入数据（管理员代建与自助注册共用同一写入入口形态）。
 *
 * `memberRole` 与实体 `chk_organization_membership_role` 值域一致；
 * 本期写路径：管理员创建账号时绑定；客户自助注册时按所选有效组织同事务绑定 CUSTOMER；
 * 工程师自助注册先落待审申请，不建成员关系，审核通过时与账号启用同事务绑定 ENGINEER。
 */
export type OrganizationMembershipInsertData = {
  /** 组织主键（管理员代建取自可信组织解析；自助注册取客户端所选、已在同事务内复核 ACTIVE） */
  organizationId: number;
  /** 账号主键（同一事务内刚创建的账号） */
  accountId: number;
  /** 组织内角色：`SUPER_ADMIN`=组织管理员；`ENGINEER`=工程师；`CUSTOMER`=客户 */
  memberRole: IdentityTypeEnum.SUPER_ADMIN | IdentityTypeEnum.ENGINEER | IdentityTypeEnum.CUSTOMER;
};

/**
 * 注册组织选项读模型：只含允许自助注册的有效组织主键与展示名称。
 *
 * 刻意不含组织编码、类别、状态、成员、管理员、内部统计或其他属性；
 * 浏览器所选 organizationId 只是申请参数，组织有效性仍由创建事务内复核。
 */
export type OrganizationRegistrationOption = {
  readonly id: number;
  readonly name: string;
};
