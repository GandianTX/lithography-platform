// src/features/admin-company-management/application/admin-company-management.policy.ts

/**
 * 公司档案管理的展示策略与输入边界。
 *
 * 权限真源在服务端（请求期查库判定等级与可信公司归属）；本文件只决定**前端呈现口径**：
 * 一级管理员看到完整列表与写入口，其余情况一律降级为只读名称名单。
 */

import type {
  AdminCompanyAdminAccountDetail,
  AdminCompanyAdminBinding,
  AdminCompanyAdminBindingStatus,
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

/** 绑定状态标签：与后端 `evaluateAdminBinding` 四态同口径 */
export const ADMIN_COMPANY_BINDING_STATUS_LABELS: Record<AdminCompanyAdminBindingStatus, string> = {
  BOUND: '已绑定',
  UNCONFIGURED: '未配置',
  CONFLICT: '冲突',
  COMPANY_DISABLED: '公司停用',
};

type BindingTagColor = 'success' | 'default' | 'warning' | 'error';

export const ADMIN_COMPANY_BINDING_STATUS_COLORS: Record<
  AdminCompanyAdminBindingStatus,
  BindingTagColor
> = {
  BOUND: 'success',
  UNCONFIGURED: 'default',
  CONFLICT: 'error',
  COMPANY_DISABLED: 'warning',
};

/**
 * 补发资格只按绑定事实判断：已绑定、账号未停用、公司启用。
 * 「是否仍待首次改密」由服务端在锁内复核，前端不据列表快照推定。
 *
 * 仅供列表/详情只读摘要使用；写入口已迁移到账号详情弹窗
 * （`canReissueCompanyAdminCredentialFromDetail`），本函数不再驱动任何补发按钮。
 */
export function canReissueCompanyAdminCredential(
  binding: AdminCompanyAdminBinding | null | undefined,
): boolean {
  return (
    binding !== null &&
    binding !== undefined &&
    binding.status === 'BOUND' &&
    !binding.accountDisabled &&
    binding.companyStatus === 'ACTIVE'
  );
}

/**
 * 账号详情弹窗的补发呈现条件：唯一合法绑定、公司启用、账号未停用、
 * **且服务端明确返回仍待首次改密**。已改密等禁止补发状态不展示写操作；
 * 服务端仍在 `reissue-level-two-credential` 锁内独立复核。
 */
export function canReissueCompanyAdminCredentialFromDetail(
  detail: AdminCompanyAdminAccountDetail | null | undefined,
): boolean {
  return (
    detail !== null &&
    detail !== undefined &&
    detail.status === 'BOUND' &&
    detail.companyStatus === 'ACTIVE' &&
    !detail.accountDisabled &&
    detail.mustChangePassword === true &&
    detail.loginName !== null
  );
}

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
