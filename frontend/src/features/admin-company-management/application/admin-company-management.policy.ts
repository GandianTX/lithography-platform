// src/features/admin-company-management/application/admin-company-management.policy.ts

/**
 * 公司档案管理的展示策略与输入边界。
 *
 * 权限真源在服务端（请求期查库判定等级与可信公司归属）；本文件只决定**前端呈现口径**：
 * 一级管理员看到完整列表与写入口，其余情况一律降级为只读名称名单。
 */

import type {
  AdminCompanyListMode,
  AdminOrganizationStatus,
} from './admin-company-management.types';

/** 字段长度上限与后端 `admin-organization.input.normalize.ts` 保持一致 */
export const ADMIN_COMPANY_NAME_MAX_LENGTH = 200;
export const ADMIN_COMPANY_SHORT_NAME_MAX_LENGTH = 100;
export const ADMIN_COMPANY_CONTACT_NAME_MAX_LENGTH = 200;
export const ADMIN_COMPANY_CONTACT_PHONE_MAX_LENGTH = 100;
export const ADMIN_COMPANY_CONTACT_EMAIL_MAX_LENGTH = 254;
export const ADMIN_COMPANY_ADDRESS_MAX_LENGTH = 1000;
export const ADMIN_COMPANY_REMARK_MAX_LENGTH = 2000;

export const ADMIN_COMPANY_STATUS_OPTIONS: readonly AdminOrganizationStatus[] = [
  'ACTIVE',
  'DISABLED',
];

export const ADMIN_COMPANY_STATUS_LABELS: Record<AdminOrganizationStatus, string> = {
  ACTIVE: '启用',
  DISABLED: '停用',
};

export const ADMIN_COMPANY_KIND_LABELS: Record<'CLIENT' | 'PEER', string> = {
  CLIENT: '甲方',
  PEER: '同行',
};

/**
 * 读入口选择：只有请求期会话等级为 1 时使用完整列表；
 * 等级缺失 / 非法 / 为 2 时降级为名称名单（服务端仍会独立裁决，前端降级不是授权依据）。
 */
export function resolveAdminCompanyListMode(adminLevel: number | null): AdminCompanyListMode {
  return adminLevel === 1 ? 'full' : 'name-only';
}

export function isAdminCompanyStatus(value: string): value is AdminOrganizationStatus {
  return (ADMIN_COMPANY_STATUS_OPTIONS as readonly string[]).includes(value);
}

// 与后端一致：只做基础格式校验，不限制企业域
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 可选邮箱：空白视为未填；非空时校验格式，返回错误文案或 null */
export function findAdminCompanyEmailIssue(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed === '') {
    return null;
  }

  return EMAIL_PATTERN.test(trimmed) ? null : '公司邮箱格式不正确';
}
