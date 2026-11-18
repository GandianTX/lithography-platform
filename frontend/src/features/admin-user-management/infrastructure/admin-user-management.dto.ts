// src/features/admin-user-management/infrastructure/admin-user-management.dto.ts

/**
 * 管理员用户管理的原始 GraphQL DTO（防腐层输入面）。
 * 仅描述后端 schema（backend/src/schema.graphql 的 adminUsers / admin* 系列）的原始形状，
 * 不承载业务规则；经 mapper 清洗后才能进入 application（见 admin-user-management-mapper.ts）。
 * 这些类型不得越出 infrastructure，application 与 ui 一律消费 feature 内部模型。
 */

export type AdminUserDto = {
  companyName: string | null;
  contactEmail: string | null;
  createdAt: string;
  id: number;
  loginEmail: string | null;
  loginName: string | null;
  nickname: string;
  phone: string | null;
  role: string;
  status: string;
  updatedAt: string;
};

export type AdminUserListPageDto = {
  items: AdminUserDto[];
  page: number;
  pageSize: number;
  total: number;
};

export type AdminResetUserPasswordResultDto = {
  accountId: number;
  isUpdated: boolean;
  notice: string;
};

/** 已绑定二级管理员（一级专用窄查询；无任何凭据字段） */
export type AdminBoundLevelTwoAdminDto = {
  accountDisabled: boolean;
  accountId: number;
  companyName: string;
  companyStatus: string;
  loginName: string;
  nickname: string | null;
  organizationCode: string;
  organizationId: number;
};

export type AdminBoundLevelTwoAdminPageDto = {
  items: AdminBoundLevelTwoAdminDto[];
  page: number;
  pageSize: number;
  total: number;
};

/** 二级管理员凭据结果（口令仅本次响应出现一次） */
export type AdminLevelTwoCredentialResultDto = {
  adminAccountId: number;
  loginName: string;
  mustChangePassword: boolean;
  nickname: string | null;
  organizationId: number;
  temporaryPassword: string;
};
