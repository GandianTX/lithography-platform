// src/usecases/organization/company-provisioning.types.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { AdminOrganizationView } from '@src/modules/lithography/organization.types';

/**
 * 「新增公司并开通二级管理员」命令。
 *
 * `submissionKey` 的三态语义（不得合并）：
 * - `undefined`：旧入口未提供标识 —— 无幂等路径，不写提交行；
 * - `null`：新入口明确缺少标识 —— 直接 `SUBMISSION_KEY_INVALID`；
 * - 字符串：归一化 UUID 后走幂等路径（预留、完成、回放）。
 */
export type ProvisionCompanyWithAdminCommand = {
  readonly session: UsecaseSession;
  readonly submissionKey?: unknown;
  readonly name: unknown;
  readonly contactPhone: unknown;
  readonly shortName?: unknown;
  readonly contactName?: unknown;
  readonly contactEmail?: unknown;
  readonly address?: unknown;
  readonly remark?: unknown;
  readonly status?: unknown;
  readonly isServiceProvider?: unknown;
};

/** 已开通二级管理员的安全摘要（不含密码、哈希或令牌）。 */
export type ProvisionedAdminSummary = {
  readonly accountId: number;
  readonly loginName: string;
  readonly nickname: string;
  /** 首次开通为 `true`；回放时取账号当前事实，可能已由用户完成首次改密。 */
  readonly mustChangePassword: boolean;
};

/**
 * 提交标识结果：`replayed=true` 表示返回的是既有提交，不再新建。
 *
 * `submissionId` 为 `null` 表示旧入口未走幂等路径（未写提交行）。
 */
export type CompanyProvisioningSubmission = {
  readonly submissionId: number | null;
  readonly replayed: boolean;
};

/**
 * 新开通用例结果。
 *
 * `temporaryPassword` 只在**首次成功**时返回一次；回放恒为 `null`，
 * 且永远不落库、不进日志或异常。
 */
export type CompanyProvisioningResult = {
  readonly organization: AdminOrganizationView;
  readonly admin: ProvisionedAdminSummary;
  readonly submission: CompanyProvisioningSubmission;
  readonly temporaryPassword: string | null;
};

/** 旧入口返回形状：公司视图 + 已开通管理员（用于兼容读取，不含口令）。 */
export type AdminOrganizationCreationResult = {
  readonly organization: AdminOrganizationView;
  readonly admin: ProvisionedAdminSummary;
};
