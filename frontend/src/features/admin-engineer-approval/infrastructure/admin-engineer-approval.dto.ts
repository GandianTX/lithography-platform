// src/features/admin-engineer-approval/infrastructure/admin-engineer-approval.dto.ts

/**
 * 工程师注册审批的原始 GraphQL DTO（防腐层输入面）。
 * 仅描述后端 schema（`adminEngineerRegistrations` / `adminEngineerRegistrationDetail` /
 * `reviewEngineerRegistration`）的原始形状，不承载业务规则；经 mapper 清洗后才能进入 application。
 */

export type AdminEngineerRegistrationApplicationDto = {
  id: number;
  accountId: number;
  organizationId: number;
  status: string;
  applicationNote: string | null;
  submittedAt: string;
  reviewedByAccountId: number | null;
  reviewedAt: string | null;
  reviewComment: string | null;
};

export type AdminEngineerApplicantDto = {
  id: number;
  loginName: string | null;
  loginEmail: string | null;
  nickname: string;
  companyName: string | null;
  phone: string | null;
  contactEmail: string | null;
  role: string;
  status: string;
};

export type AdminEngineerRegistrationItemDto = {
  application: AdminEngineerRegistrationApplicationDto;
  applicant: AdminEngineerApplicantDto;
  organizationName: string | null;
};

/** 审批详情专用申请人 DTO：含真实姓名，不含角色 / 账号状态 / 登录邮箱 */
export type AdminEngineerApplicantDetailDto = {
  id: number;
  loginName: string | null;
  nickname: string;
  realName: string | null;
  phone: string | null;
  contactEmail: string | null;
};

export type AdminEngineerRegistrationDetailDto = {
  application: AdminEngineerRegistrationApplicationDto;
  applicant: AdminEngineerApplicantDetailDto;
  organizationName: string | null;
};

export type AdminEngineerRegistrationPageDto = {
  items: AdminEngineerRegistrationItemDto[];
  page: number;
  pageSize: number;
  total: number;
};
