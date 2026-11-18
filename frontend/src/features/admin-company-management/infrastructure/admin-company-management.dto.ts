// src/features/admin-company-management/infrastructure/admin-company-management.dto.ts

/**
 * 公司档案管理的原始 GraphQL DTO（防腐层输入面）。
 * 仅描述后端 schema（`adminOrganizationList` / `adminOrganizationDetail` /
 * `adminProvisionCompany` / `adminUpdateOrganization` / `adminOrganizationNameList`）的原始形状，
 * 不承载业务规则；经 mapper 清洗后才能进入 application。
 */

export type AdminOrganizationDto = {
  id: number;
  organizationCode: string;
  name: string;
  shortName: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  address: string | null;
  remark: string | null;
  isServiceProvider: boolean;
  isManagedCompany: boolean;
  kind: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type AdminOrganizationPageDto = {
  items: AdminOrganizationDto[];
  page: number;
  pageSize: number;
  total: number;
};

export type AdminOrganizationNameDto = {
  id: number;
  name: string;
};

export type AdminOrganizationNamePageDto = {
  items: AdminOrganizationNameDto[];
  page: number;
  pageSize: number;
  total: number;
};

/** 已开通二级管理员的安全摘要（不含任何凭据） */
export type ProvisionedAdminDto = {
  accountId: number;
  loginName: string;
  nickname: string;
  mustChangePassword: boolean;
};

/** 提交标识结果：`replayed=true` 表示返回既有提交 */
export type ProvisioningSubmissionDto = {
  submissionId: number | null;
  replayed: boolean;
};

/**
 * `adminProvisionCompany` 结果信封。
 *
 * `temporaryPassword` 只在**首次成功**时由服务端返回一次；回放恒为 `null`。
 * 该字段只允许停留在当次成功弹窗的组件 state 中，不得写入持久化存储或缓存。
 */
export type AdminCompanyProvisioningResultDto = {
  organization: AdminOrganizationDto;
  provisionedAdmin: ProvisionedAdminDto;
  submission: ProvisioningSubmissionDto;
  temporaryPassword: string | null;
};

/** 一级按公司查询的绑定事实（只读、无凭据字段） */
export type AdminCompanyAdminBindingDto = {
  organizationId: number;
  organizationCode: string;
  companyName: string;
  isManagedCompany: boolean;
  companyStatus: string;
  status: string;
  reason: string | null;
  boundAccountId: number | null;
  boundLoginNameMasked: string | null;
  candidateCount: number;
  accountDisabled: boolean;
};

/** 一级按公司窄查询的账号详情（只读、无凭据字段） */
export type AdminCompanyAdminAccountDetailDto = {
  organizationId: number;
  organizationCode: string;
  companyName: string;
  isManagedCompany: boolean;
  companyStatus: string;
  status: string;
  reason: string | null;
  accountId: number | null;
  loginName: string | null;
  nickname: string | null;
  mustChangePassword: boolean | null;
  accountDisabled: boolean;
  candidateCount: number;
};

/** 补发 / 重置结果：临时密码只在本次成功响应中出现 */
export type AdminLevelTwoCredentialResultDto = {
  organizationId: number;
  adminAccountId: number;
  loginName: string;
  nickname: string | null;
  mustChangePassword: boolean;
  temporaryPassword: string;
};
