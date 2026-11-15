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

export type AdminEngineerRegistrationPageDto = {
  items: AdminEngineerRegistrationItemDto[];
  page: number;
  pageSize: number;
  total: number;
};
