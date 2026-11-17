// src/usecases/organization/company-admin-binding.support.ts

import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  evaluateAdminBinding,
  type AdminBindingCandidate,
  type AdminBindingFacts,
} from '@core/account/policy/admin-binding.policy';
import type { AdminBindingCandidateFacts } from '@src/modules/account/account.types';
import type { AdminOrganizationView } from '@src/modules/lithography/organization.types';
import type { CompanyAdminBindingView } from './company-admin-binding.types';

/** 绑定判定所需的成员关系窄事实（成员角色与成员状态都是判定输入） */
export type AdminBindingMembershipFact = {
  readonly accountId: number;
  readonly memberRole: string;
  readonly status: string;
};

/** 二级管理员绑定候选的账号级事实（登录名完整值只在服务端使用） */
export type AdminBindingAccountFact = AdminBindingCandidateFacts;

/** 从成员关系中取 ACTIVE 账号 ID（去重），供批量读取账号事实 */
export function collectActiveMembershipAccountIds(
  memberships: ReadonlyArray<AdminBindingMembershipFact>,
): number[] {
  const accountIds = new Set<number>();
  for (const membership of memberships) {
    if (membership.status === 'ACTIVE') {
      accountIds.add(membership.accountId);
    }
  }
  return [...accountIds];
}

/**
 * 把成员关系与账号事实装配为绑定策略输入。
 *
 * 候选口径与部署盘点（`loadAdminBindingCandidateRows`）一致：
 * - 只看 ACTIVE 成员关系（`chk_organization_membership_period` 保证 ACTIVE 时 `left_at IS NULL`）；
 * - 候选条件 `admin_level = 2 OR member_role = 'SUPER_ADMIN'`；
 * - 账号行缺失（外键不应允许）按不存在处理，不参与判定。
 *
 * 本函数不复制 `evaluateAdminBinding` 的任何判定逻辑。
 */
export function assembleAdminBindingFacts(params: {
  organizationId: number;
  organizationCode: string;
  companyStatus: string;
  isManagedCompany: boolean;
  memberships: ReadonlyArray<AdminBindingMembershipFact>;
  accountFacts: ReadonlyMap<number, AdminBindingAccountFact>;
}): AdminBindingFacts {
  const candidates: AdminBindingCandidate[] = [];
  for (const membership of params.memberships) {
    if (membership.status !== 'ACTIVE') {
      continue;
    }
    const facts = params.accountFacts.get(membership.accountId);
    if (facts === undefined) {
      continue;
    }
    const isCandidate =
      facts.adminLevel === 2 || membership.memberRole === String(IdentityTypeEnum.SUPER_ADMIN);
    if (!isCandidate) {
      continue;
    }
    candidates.push({
      accountId: facts.accountId,
      loginName: facts.loginName,
      adminLevel: facts.adminLevel,
      accountStatus: facts.accountStatus,
      userState: facts.userState,
      roleConverged: facts.roleConverged,
      role: facts.role,
      membershipRole: membership.memberRole,
      membershipActive: true,
      customerOrganizationId: facts.customerOrganizationId,
    });
  }

  return {
    organizationId: params.organizationId,
    organizationCode: params.organizationCode,
    companyStatus: params.companyStatus,
    isManagedCompany: params.isManagedCompany,
    candidates,
  };
}

/**
 * 公司视图 + 绑定判定 → 对外绑定视图（只输出脱敏登录名）。
 *
 * 非受管公司不进入策略（策略会抛错），直接归一为 `UNCONFIGURED` 安全状态。
 */
export function toCompanyAdminBindingView(
  organization: AdminOrganizationView,
  facts: AdminBindingFacts,
): CompanyAdminBindingView {
  const evaluation = evaluateAdminBinding(facts);
  return {
    organizationId: organization.id,
    organizationCode: organization.organizationCode,
    companyName: organization.name,
    isManagedCompany: organization.isManagedCompany,
    companyStatus: organization.status,
    status: evaluation.status,
    reason: evaluation.reason,
    boundAccountId: evaluation.boundAccountId,
    boundLoginNameMasked: evaluation.boundLoginNameMasked,
    candidateCount: evaluation.candidateCount,
    accountDisabled: evaluation.accountDisabled,
  };
}
