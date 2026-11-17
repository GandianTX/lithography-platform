// src/core/account/policy/admin-binding.policy.ts

import { IdentityTypeEnum } from '@app-types/models/account.types';

/**
 * 二级管理员绑定判定（单一事实口径）。
 *
 * 部署初始化、在线开通与存量盘点必须共用本策略，禁止各自写一套“是否已绑定”的判断：
 * - 公司必须是显式配置的受管公司；
 * - 公司内最多只能有一个合法二级账号；
 * - 账号级别必须为 2；
 * - 三源角色事实必须收敛为 `SUPER_ADMIN`；
 * - 必须存在同一公司的 ACTIVE `SUPER_ADMIN` 成员关系；
 * - 账号与资料状态必须是正常双状态。
 *
 * 已合法绑定但账号停用的公司仍返回 `BOUND`（`accountDisabled=true`），调用方必须沿用
 * 该账号标识并保持原状态，不得因此再建第二个账号。
 *
 * 本函数是纯函数：无 I/O、无 ORM、无日志。冲突输出只暴露账号 ID 与脱敏登录名，
 * 不输出完整登录名、邮箱、角色原值或凭据。
 */
export type AdminBindingStatus = 'BOUND' | 'UNCONFIGURED' | 'CONFLICT' | 'COMPANY_DISABLED';

export type AdminBindingConflictReason =
  | 'MULTIPLE_BINDINGS'
  | 'LEVEL_MISMATCH'
  | 'ROLE_NOT_CONVERGED'
  | 'ROLE_NOT_SUPER_ADMIN'
  | 'MEMBERSHIP_ROLE_MISMATCH'
  | 'MEMBERSHIP_INACTIVE'
  | 'ORGANIZATION_MISMATCH';

export interface AdminBindingCandidate {
  readonly accountId: number;
  readonly loginName: string;
  readonly adminLevel: number | null;
  readonly accountStatus: string;
  readonly userState: string | null;
  readonly roleConverged: boolean;
  readonly role: string | null;
  readonly membershipRole: string;
  readonly membershipActive: boolean;
  readonly customerOrganizationId: number | null;
}

export interface AdminBindingFacts {
  readonly organizationId: number;
  readonly organizationCode: string;
  readonly companyStatus: string;
  readonly isManagedCompany: boolean;
  readonly candidates: ReadonlyArray<AdminBindingCandidate>;
}

export interface AdminBindingCandidateRef {
  readonly accountId: number;
  readonly loginNameMasked: string;
}

export interface AdminBindingEvaluation {
  readonly status: AdminBindingStatus;
  readonly reason: AdminBindingConflictReason | null;
  readonly boundAccountId: number | null;
  /**
   * 仅供内部比较“配置登录名是否等于唯一绑定账号”使用。
   * 任何日志、异常、报告与 GraphQL 输出都必须使用 `boundLoginNameMasked`。
   */
  readonly boundLoginName: string | null;
  readonly boundLoginNameMasked: string | null;
  readonly candidateCount: number;
  readonly accountDisabled: boolean;
  readonly candidates: ReadonlyArray<AdminBindingCandidateRef>;
}

const ADMIN_ROLE = IdentityTypeEnum.SUPER_ADMIN;
const ACTIVE = 'ACTIVE';

/**
 * 登录名脱敏：保留首尾各 1 个字符，其余替换为 `***`。
 *
 * 仅用于冲突清单与报告定位，不改变任何持久化事实。
 */
export function maskLoginName(loginName: string): string {
  const trimmed = loginName.trim();
  if (trimmed.length === 0) {
    return '(空)';
  }
  if (trimmed.length <= 2) {
    return `${trimmed.slice(0, 1)}***`;
  }
  return `${trimmed.slice(0, 1)}***${trimmed.slice(-1)}`;
}

function evaluateCandidateInvalidReason(
  candidate: AdminBindingCandidate,
  organizationId: number,
): AdminBindingConflictReason | null {
  if (!candidate.membershipActive) {
    return 'MEMBERSHIP_INACTIVE';
  }
  if (candidate.membershipRole !== String(ADMIN_ROLE)) {
    return 'MEMBERSHIP_ROLE_MISMATCH';
  }
  if (candidate.adminLevel !== 2) {
    return 'LEVEL_MISMATCH';
  }
  if (!candidate.roleConverged) {
    return 'ROLE_NOT_CONVERGED';
  }
  if (candidate.role !== String(ADMIN_ROLE)) {
    return 'ROLE_NOT_SUPER_ADMIN';
  }
  if (
    candidate.customerOrganizationId !== null &&
    candidate.customerOrganizationId !== organizationId
  ) {
    return 'ORGANIZATION_MISMATCH';
  }
  return null;
}

function isCandidateDisabled(candidate: AdminBindingCandidate): boolean {
  return candidate.accountStatus !== ACTIVE || candidate.userState !== ACTIVE;
}

/**
 * 判定一个受管公司的二级管理员绑定状态。
 *
 * 调用方必须只传入受管公司；非受管公司不是本策略的判定对象。
 */
export function evaluateAdminBinding(facts: AdminBindingFacts): AdminBindingEvaluation {
  if (!facts.isManagedCompany) {
    throw new Error(`公司 ${facts.organizationCode} 不是受管公司，不能判定二级管理员绑定`);
  }

  const candidates: AdminBindingCandidateRef[] = facts.candidates.map((candidate) => ({
    accountId: candidate.accountId,
    loginNameMasked: maskLoginName(candidate.loginName),
  }));
  const companyDisabled = facts.companyStatus !== ACTIVE;

  if (facts.candidates.length === 0) {
    return {
      status: companyDisabled ? 'COMPANY_DISABLED' : 'UNCONFIGURED',
      reason: null,
      boundAccountId: null,
      boundLoginName: null,
      boundLoginNameMasked: null,
      candidateCount: 0,
      accountDisabled: false,
      candidates,
    };
  }

  if (facts.candidates.length > 1) {
    return {
      status: companyDisabled ? 'COMPANY_DISABLED' : 'CONFLICT',
      reason: 'MULTIPLE_BINDINGS',
      boundAccountId: null,
      boundLoginName: null,
      boundLoginNameMasked: null,
      candidateCount: facts.candidates.length,
      accountDisabled: false,
      candidates,
    };
  }

  const candidate = facts.candidates[0];
  const invalidReason = evaluateCandidateInvalidReason(candidate, facts.organizationId);
  const identityValid = invalidReason === null;

  if (companyDisabled) {
    return {
      status: 'COMPANY_DISABLED',
      reason: invalidReason,
      boundAccountId: identityValid ? candidate.accountId : null,
      boundLoginName: identityValid ? candidate.loginName : null,
      boundLoginNameMasked: identityValid ? maskLoginName(candidate.loginName) : null,
      candidateCount: 1,
      accountDisabled: isCandidateDisabled(candidate),
      candidates,
    };
  }

  if (invalidReason !== null) {
    return {
      status: 'CONFLICT',
      reason: invalidReason,
      boundAccountId: null,
      boundLoginName: null,
      boundLoginNameMasked: null,
      candidateCount: 1,
      accountDisabled: isCandidateDisabled(candidate),
      candidates,
    };
  }

  return {
    status: 'BOUND',
    reason: null,
    boundAccountId: candidate.accountId,
    boundLoginName: candidate.loginName,
    boundLoginNameMasked: maskLoginName(candidate.loginName),
    candidateCount: 1,
    accountDisabled: isCandidateDisabled(candidate),
    candidates,
  };
}
