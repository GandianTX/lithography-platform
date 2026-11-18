// src/usecases/organization/level-two-credential.support.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { evaluateAdminBinding, maskLoginName } from '@core/account/policy/admin-binding.policy';
import { DomainError, ORGANIZATION_MANAGEMENT_ERROR } from '@core/common/errors/domain-error';
import type { PasswordPolicyService } from '@core/common/password/password-policy.service';
import { generateTemporaryPasswordCandidate } from '@core/organization/policy/admin-organization-provisioning.policy';
import { randomBytes } from 'crypto';
import type { AccountService } from '@src/modules/account/base/services/account.service';
import type { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import type { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import type { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { OrganizationStatus } from '@src/modules/lithography/organization.types';
import {
  assembleAdminBindingFacts,
  collectActiveMembershipAccountIds,
} from './company-admin-binding.support';

/** 临时密码候选的最大策略重试次数（与开通用例同口径） */
const TEMPORARY_PASSWORD_MAX_ATTEMPTS = 5;

/** 补发 / 重置共用的读依赖（由调用用例注入后传入，避免支撑文件携带 DI 装配） */
export interface LevelTwoCredentialLookupDeps {
  readonly organizationQueryService: OrganizationQueryService;
  readonly organizationMembershipQueryService: OrganizationMembershipQueryService;
  readonly adminUserQueryService: AdminUserQueryService;
  readonly accountService: AccountService;
}

/** 事务内锁定的合法绑定二级管理员（凭据写入前的唯一真源） */
export interface LockedBoundLevelTwoAdmin {
  readonly organizationId: number;
  readonly organizationCode: string;
  readonly companyName: string;
  readonly companyStatus: OrganizationStatus;
  readonly accountId: number;
  readonly loginName: string;
  readonly nickname: string | null;
  readonly mustChangePassword: boolean;
  /** 账号创建时间，作为新密码哈希的盐（锁内读取） */
  readonly credentialCreatedAt: Date;
  readonly credentialVersion: number;
}

/**
 * 事务内锁定目标公司并复核其唯一合法二级管理员绑定。
 *
 * 锁序固定为 organization → account → membership：
 * 1. `lockAdminOrganizationForUpdate` 锁公司行；
 * 2. 非锁读成员关系得到候选账号集，先做一次无锁事实读取以确定「可能是候选」的账号；
 * 3. `findAdminBindingCandidateFacts({ forUpdate: true })` 锁候选账号行；
 * 4. `listMembershipsByOrganization({ forUpdate: true })` 锁成员关系；
 * 5. 用锁内事实重新装配并 `evaluateAdminBinding`，不信任任何锁外快照。
 *
 * 拒绝口径（全部为写前拒绝，不产生任何写入）：
 * - 公司不存在 → `TARGET_NOT_FOUND`；
 * - 非受管公司 / 无合法绑定 / `expectedAccountId` 与绑定不一致 → `ADMIN_BINDING_REQUIRED`；
 * - 冲突、公司停用、账号停用 → `CREDENTIAL_REISSUE_NOT_ALLOWED`。
 */
export async function loadBoundLevelTwoAdminForUpdate(params: {
  deps: LevelTwoCredentialLookupDeps;
  organizationId: number;
  transactionContext: PersistenceTransactionContext;
  expectedAccountId?: number | null;
}): Promise<LockedBoundLevelTwoAdmin> {
  const { deps, organizationId, transactionContext } = params;

  const organization = await deps.organizationQueryService.lockAdminOrganizationForUpdate({
    organizationId,
    transactionContext,
  });
  if (organization === null) {
    throw new DomainError(ORGANIZATION_MANAGEMENT_ERROR.TARGET_NOT_FOUND, '公司不存在或已被删除', {
      organizationId,
    });
  }
  if (!organization.isManagedCompany) {
    throw new DomainError(
      ORGANIZATION_MANAGEMENT_ERROR.ADMIN_BINDING_REQUIRED,
      '目标公司不属于受管公司，未绑定二级管理员',
      { organizationId },
    );
  }

  // 锁外只用于圈定候选账号集，最终判定一律使用锁内事实。
  const preliminaryMemberships =
    await deps.organizationMembershipQueryService.listMembershipsByOrganization({
      organizationId,
      transactionContext,
    });
  const preliminaryFacts = await deps.adminUserQueryService.findAdminBindingCandidateFacts({
    accountIds: collectActiveMembershipAccountIds(preliminaryMemberships),
    transactionContext,
  });
  const candidateAccountIds = preliminaryMemberships
    .filter((membership) => membership.status === 'ACTIVE')
    .filter((membership) => {
      const facts = preliminaryFacts.get(membership.accountId);
      return (
        facts !== undefined && (facts.adminLevel === 2 || membership.memberRole === 'SUPER_ADMIN')
      );
    })
    .map((membership) => membership.accountId);

  const lockedAccountFacts = await deps.adminUserQueryService.findAdminBindingCandidateFacts({
    accountIds: candidateAccountIds,
    transactionContext,
    forUpdate: true,
  });
  const lockedMemberships =
    await deps.organizationMembershipQueryService.listMembershipsByOrganization({
      organizationId,
      transactionContext,
      forUpdate: true,
    });

  const facts = assembleAdminBindingFacts({
    organizationId: organization.id,
    organizationCode: organization.organizationCode,
    companyStatus: organization.status,
    isManagedCompany: organization.isManagedCompany,
    memberships: lockedMemberships,
    accountFacts: lockedAccountFacts,
  });
  const evaluation = evaluateAdminBinding(facts);

  if (evaluation.status === 'UNCONFIGURED') {
    throw new DomainError(
      ORGANIZATION_MANAGEMENT_ERROR.ADMIN_BINDING_REQUIRED,
      '目标公司尚未绑定二级管理员',
      { organizationId },
    );
  }
  if (evaluation.status !== 'BOUND' || evaluation.boundAccountId === null) {
    throw new DomainError(
      ORGANIZATION_MANAGEMENT_ERROR.CREDENTIAL_REISSUE_NOT_ALLOWED,
      '目标公司的二级管理员绑定状态异常，无法变更凭据',
      { organizationId, status: evaluation.status },
    );
  }
  if (evaluation.accountDisabled) {
    throw new DomainError(
      ORGANIZATION_MANAGEMENT_ERROR.CREDENTIAL_REISSUE_NOT_ALLOWED,
      '目标账号已停用，无法变更凭据',
      { organizationId },
    );
  }
  if (
    params.expectedAccountId !== undefined &&
    params.expectedAccountId !== null &&
    evaluation.boundAccountId !== params.expectedAccountId
  ) {
    throw new DomainError(
      ORGANIZATION_MANAGEMENT_ERROR.ADMIN_BINDING_REQUIRED,
      '目标账号不是该公司的合法绑定二级管理员',
      { organizationId },
    );
  }

  const accountId = evaluation.boundAccountId;
  const snapshot = await deps.accountService.lockMyAccountCredentialSnapshot({
    accountId,
    transactionContext,
  });
  if (snapshot === null) {
    throw new DomainError(
      ORGANIZATION_MANAGEMENT_ERROR.CREDENTIAL_REISSUE_NOT_ALLOWED,
      '目标账号不存在，无法变更凭据',
      { organizationId },
    );
  }

  const boundFacts = lockedAccountFacts.get(accountId);
  return {
    organizationId: organization.id,
    organizationCode: organization.organizationCode,
    companyName: organization.name,
    companyStatus: organization.status,
    accountId,
    loginName: boundFacts?.loginName ?? '',
    nickname: boundFacts?.nickname ?? null,
    mustChangePassword: snapshot.mustChangePassword,
    credentialCreatedAt: snapshot.createdAt,
    credentialVersion: snapshot.credentialVersion,
  };
}

/**
 * 补发只允许尚待首次改密的目标；已首次改密必须走二级专用重置。
 */
export function assertReissueAllowed(bound: LockedBoundLevelTwoAdmin): void {
  if (bound.mustChangePassword !== true) {
    throw new DomainError(
      ORGANIZATION_MANAGEMENT_ERROR.CREDENTIAL_REISSUE_NOT_ALLOWED,
      '该管理员已完成首次改密，不能补发临时密码；如需重新开通请使用重置',
      { organizationId: bound.organizationId },
    );
  }
}

/**
 * 生成满足密码策略的临时密码候选；失败不以任何形式外泄候选值。
 */
export function generatePolicyCompliantTemporaryPassword(
  passwordPolicyService: PasswordPolicyService,
): string {
  for (let attempt = 0; attempt < TEMPORARY_PASSWORD_MAX_ATTEMPTS; attempt += 1) {
    const candidate = generateTemporaryPasswordCandidate(randomBytes);
    if (passwordPolicyService.validatePassword(candidate).isValid) {
      return candidate;
    }
  }

  throw new DomainError(
    ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
    '临时密码生成失败，请稍后重试',
    undefined,
    { diagnostic: 'TEMPORARY_PASSWORD_POLICY_UNSATISFIED' },
  );
}

/** 审计 detail 使用的脱敏登录名（完整登录名不得进入审计或日志） */
export function maskedLoginNameOf(bound: LockedBoundLevelTwoAdmin): string {
  return maskLoginName(bound.loginName);
}
