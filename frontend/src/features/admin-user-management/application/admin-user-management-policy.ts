// src/features/admin-user-management/application/admin-user-management-policy.ts

/**
 * - 只读判定、可写状态、范围提示等展示判断只在这里实现，
 *   ui 层不得再各自派生第二份只读/可写语义；
 * - 前端策略只控制展示，后端（Usecase 精确授权 + 转换矩阵）仍是权限与业务真源；
 *   前端隐藏入口不构成安全边界。
 */

import type {
  AdminUserFilterRole,
  AdminUserRole,
  AdminUserRow,
  AdminUserStatusFilter,
} from './admin-user-management.types';

/** 列表角色筛选只开放普通用户：管理员账号不属于本期读面 */
export const ADMIN_USER_ROLE_FILTER_OPTIONS: readonly AdminUserFilterRole[] = [
  'ENGINEER',
  'CUSTOMER',
];

/** 状态筛选与启停写入口都只开放 ACTIVE / INACTIVE */
export const ADMIN_USER_STATUS_FILTER_OPTIONS: readonly AdminUserStatusFilter[] = [
  'ACTIVE',
  'INACTIVE',
];

export const ADMIN_USER_ROW_READ_ONLY_REASON = 'SUPER_ADMIN 账号为只读，不可停用或重置密码。';

/**
 * 展示标签统一口径：panel 与各弹窗共用，不各自维护第二份映射。
 */
export const ADMIN_USER_ROLE_LABELS: Record<AdminUserRole, string> = {
  SUPER_ADMIN: '超级管理员',
  ENGINEER: '工程师',
  CUSTOMER: '客户',
};

export const ADMIN_USER_STATUS_LABELS: Record<AdminUserStatusFilter, string> = {
  ACTIVE: '启用',
  INACTIVE: '停用',
};

export function isAdminUserRowReadOnly(row: AdminUserRow): boolean {
  return row.role === 'SUPER_ADMIN';
}

/**
 * 行状态是否在可写值域（ACTIVE / INACTIVE）内。
 * 页面只识别这两态并开放启停/重置入口；其余状态（防御性兜底）一律不可写，仅展示原值。
 */
export function isAdminUserStatusWritable(status: string): status is AdminUserStatusFilter {
  return status === 'ACTIVE' || status === 'INACTIVE';
}

/** 启停要求目标行状态在 ACTIVE / INACTIVE 两态内（与后端转换矩阵的展示镜像一致） */
export function canToggleAdminUserStatus(row: AdminUserRow): boolean {
  return !isAdminUserRowReadOnly(row) && isAdminUserStatusWritable(row.status);
}

/** 密码重置与启停同边界：仅可写状态值域内的普通账号开放入口（展示镜像，后端是矩阵真源） */
export function canResetAdminUserPassword(row: AdminUserRow): boolean {
  return !isAdminUserRowReadOnly(row) && isAdminUserStatusWritable(row.status);
}

/**
 * 二级管理员凭据重置入口：仅一级管理员出现。
 * 等级缺失 / 非法 / 为二时一律不渲染入口（服务端仍独立裁决并返回 FORBIDDEN）。
 */
export function canManageLevelTwoCredentials(adminLevel: number | null): boolean {
  return adminLevel === 1;
}

/**
 * 可见范围提示：等级只用于文案，不是授权依据。
 * 等级缺失或非法时不承诺任何范围，避免误导为「全部公司」。
 */
export function resolveAdminUserScopeHint(adminLevel: number | null): string {
  if (adminLevel === 1) {
    return '当前账号可查看并管理全部公司的普通用户账号。';
  }

  if (adminLevel === 2) {
    return '当前账号仅可查看并管理本公司的普通用户账号。';
  }

  return '当前账号的管理范围以服务端判定为准。';
}
