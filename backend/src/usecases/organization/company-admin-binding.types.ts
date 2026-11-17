// src/usecases/organization/company-admin-binding.types.ts

import type {
  AdminBindingConflictReason,
  AdminBindingStatus,
} from '@core/account/policy/admin-binding.policy';
import type { OrganizationStatus } from '@src/modules/lithography/organization.types';

/**
 * 一级管理员按公司查询的二级管理员绑定视图（只读、无凭据字段）。
 *
 * 安全口径：
 * - `boundLoginName` 完整登录名只供服务端内部比较，本视图只输出脱敏名；
 * - 冲突 / 停用等异常状态只给 `status` + `reason` + 脱敏候选，不泄露完整凭据；
 * - 非受管公司返回 `UNCONFIGURED` 且 `isManagedCompany=false`，属安全状态而非错误。
 */
export type CompanyAdminBindingView = {
  readonly organizationId: number;
  readonly organizationCode: string;
  readonly companyName: string;
  readonly isManagedCompany: boolean;
  readonly companyStatus: OrganizationStatus;
  readonly status: AdminBindingStatus;
  readonly reason: AdminBindingConflictReason | null;
  readonly boundAccountId: number | null;
  readonly boundLoginNameMasked: string | null;
  readonly candidateCount: number;
  readonly accountDisabled: boolean;
};

/**
 * 「已绑定二级管理员」一级专用列表项。
 *
 * 只包含 `BOUND` 绑定：公司、账号定位、登录名与昵称，供用户管理选择目标。
 * `accountDisabled` 为 true 时前端应禁用选择（补发/重置会拒绝账号停用目标）。
 */
export type BoundLevelTwoAdminView = {
  readonly organizationId: number;
  readonly organizationCode: string;
  readonly companyName: string;
  readonly companyStatus: OrganizationStatus;
  readonly accountId: number;
  readonly loginName: string;
  readonly nickname: string | null;
  readonly accountDisabled: boolean;
};

/** 已绑定二级管理员内存分页结果 */
export type BoundLevelTwoAdminPage = {
  readonly items: BoundLevelTwoAdminView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
};

/**
 * 补发 / 二级专用重置的成功结果。
 *
 * `temporaryPassword` 只在本次成功响应中返回一次，服务端不持久化明文，
 * 审计与日志都不得写入该值或其派生值。
 */
export type LevelTwoCredentialResult = {
  readonly organizationId: number;
  readonly adminAccountId: number;
  readonly loginName: string;
  readonly nickname: string | null;
  readonly mustChangePassword: boolean;
  readonly temporaryPassword: string;
};
