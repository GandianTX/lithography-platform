// src/features/admin-company-management/infrastructure/admin-company-management.dto.ts

/**
 * 公司档案管理的原始 GraphQL DTO（防腐层输入面）。
 * 仅描述后端 schema（`adminOrganizationList` / `adminOrganizationDetail` /
 * `adminCreateOrganization` / `adminUpdateOrganization` / `adminOrganizationNameList`）的原始形状，
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
