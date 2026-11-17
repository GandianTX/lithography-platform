// src/usecases/organization/level-two-credential.usecases.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import {
  INPUT_NORMALIZE_ERROR,
  ORGANIZATION_MANAGEMENT_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type { PasswordPolicyService } from '@core/common/password/password-policy.service';
import type { PinoLogger } from 'nestjs-pino';
import type {
  AccountCredentialSnapshot,
  AdminBindingCandidateFacts,
} from '@src/modules/account/account.types';
import type { AccountService } from '@src/modules/account/base/services/account.service';
import type { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import type { ManagementAuditService } from '@src/modules/lithography/management-audit.service';
import type { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import type { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { AdminOrganizationView } from '@src/modules/lithography/organization.types';
import { createFakeTransactionHarness } from '../../../test/support/account/admin-user.fixture';
import { ReissueLevelTwoCredentialUsecase } from './reissue-level-two-credential.usecase';
import { ResetLevelTwoCredentialUsecase } from './reset-level-two-credential.usecase';

const ORGANIZATION_ID = 7;
const ADMIN_ACCOUNT_ID = 55;
const DB_CREATED_AT = new Date('2026-02-01T00:00:00Z');

const levelOneSession: UsecaseSession = {
  accountId: 30,
  roles: [IdentityTypeEnum.SUPER_ADMIN],
  activeRole: IdentityTypeEnum.SUPER_ADMIN,
  adminLevel: 1,
  adminOrganizationId: null,
};

const levelTwoSession: UsecaseSession = {
  accountId: 31,
  roles: [IdentityTypeEnum.SUPER_ADMIN],
  activeRole: IdentityTypeEnum.SUPER_ADMIN,
  adminLevel: 2,
  adminOrganizationId: ORGANIZATION_ID,
};

const organization = (overrides: Partial<AdminOrganizationView> = {}): AdminOrganizationView => ({
  id: ORGANIZATION_ID,
  organizationCode: 'ADMIN_ORG_0007',
  name: '示例维护公司',
  shortName: null,
  contactName: null,
  contactPhone: '021-1',
  contactEmail: null,
  address: null,
  remark: null,
  isServiceProvider: false,
  isManagedCompany: true,
  kind: 'CLIENT',
  status: 'ACTIVE',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

const membership = (
  overrides: Partial<{
    membershipId: number;
    accountId: number;
    memberRole: string;
    status: string;
  }> = {},
) => ({
  membershipId: 1,
  accountId: ADMIN_ACCOUNT_ID,
  memberRole: String(IdentityTypeEnum.SUPER_ADMIN),
  status: 'ACTIVE',
  ...overrides,
});

const candidateFacts = (
  overrides: Partial<AdminBindingCandidateFacts> = {},
): AdminBindingCandidateFacts => ({
  accountId: ADMIN_ACCOUNT_ID,
  loginName: 'acct-admin-01',
  nickname: '二级管理员',
  adminLevel: 2,
  accountStatus: AccountStatus.ACTIVE,
  userState: UserState.ACTIVE,
  roleConverged: true,
  role: IdentityTypeEnum.SUPER_ADMIN,
  customerOrganizationId: ORGANIZATION_ID,
  ...overrides,
});

const credentialSnapshot = (
  overrides: Partial<AccountCredentialSnapshot> = {},
): AccountCredentialSnapshot => ({
  id: ADMIN_ACCOUNT_ID,
  status: AccountStatus.ACTIVE,
  loginPassword: 'stored-hash',
  createdAt: DB_CREATED_AT,
  mustChangePassword: true,
  credentialVersion: 0,
  ...overrides,
});

interface Harness {
  readonly organizationQueryService: { lockAdminOrganizationForUpdate: jest.Mock };
  readonly organizationMembershipQueryService: { listMembershipsByOrganization: jest.Mock };
  readonly adminUserQueryService: { findAdminBindingCandidateFacts: jest.Mock };
  readonly accountService: {
    lockMyAccountCredentialSnapshot: jest.Mock;
    updateAccountPasswordHash: jest.Mock;
  };
  readonly managementAuditService: { append: jest.Mock };
  readonly passwordPolicyService: { validatePassword: jest.Mock };
  readonly logger: { setContext: jest.Mock; info: jest.Mock; error: jest.Mock };
  readonly transactions: ReturnType<typeof createFakeTransactionHarness>;
}

function createHarness(): Harness {
  const harness: Harness = {
    organizationQueryService: {
      lockAdminOrganizationForUpdate: jest.fn().mockResolvedValue(organization()),
    },
    organizationMembershipQueryService: {
      listMembershipsByOrganization: jest.fn().mockResolvedValue([membership()]),
    },
    adminUserQueryService: {
      findAdminBindingCandidateFacts: jest.fn(() =>
        Promise.resolve(new Map([[ADMIN_ACCOUNT_ID, candidateFacts()]])),
      ),
    },
    accountService: {
      lockMyAccountCredentialSnapshot: jest.fn().mockResolvedValue(credentialSnapshot()),
      updateAccountPasswordHash: jest.fn().mockResolvedValue(undefined),
    },
    managementAuditService: { append: jest.fn().mockResolvedValue(undefined) },
    passwordPolicyService: {
      validatePassword: jest.fn().mockReturnValue({ isValid: true, errors: [], strength: 90 }),
    },
    logger: { setContext: jest.fn(), info: jest.fn(), error: jest.fn() },
    transactions: createFakeTransactionHarness(),
  };
  return harness;
}

function buildReissue(harness: Harness): ReissueLevelTwoCredentialUsecase {
  return new ReissueLevelTwoCredentialUsecase(
    harness.organizationQueryService as unknown as OrganizationQueryService,
    harness.organizationMembershipQueryService as unknown as OrganizationMembershipQueryService,
    harness.adminUserQueryService as unknown as AdminUserQueryService,
    harness.accountService as unknown as AccountService,
    harness.managementAuditService as unknown as ManagementAuditService,
    harness.passwordPolicyService as unknown as PasswordPolicyService,
    harness.logger as unknown as PinoLogger,
    harness.transactions.transactionRunner,
  );
}

function buildReset(harness: Harness): ResetLevelTwoCredentialUsecase {
  return new ResetLevelTwoCredentialUsecase(
    harness.organizationQueryService as unknown as OrganizationQueryService,
    harness.organizationMembershipQueryService as unknown as OrganizationMembershipQueryService,
    harness.adminUserQueryService as unknown as AdminUserQueryService,
    harness.accountService as unknown as AccountService,
    harness.managementAuditService as unknown as ManagementAuditService,
    harness.passwordPolicyService as unknown as PasswordPolicyService,
    harness.logger as unknown as PinoLogger,
    harness.transactions.transactionRunner,
  );
}

describe('ReissueLevelTwoCredentialUsecase', () => {
  let harness: Harness;
  let usecase: ReissueLevelTwoCredentialUsecase;

  beforeEach(() => {
    harness = createHarness();
    usecase = buildReissue(harness);
  });

  it('成功：写新哈希 + 置强制改密 + 递增代次 + 同事务审计，口令仅本次返回', async () => {
    const result = await usecase.execute({
      session: levelOneSession,
      organizationId: ORGANIZATION_ID,
    });

    expect(result).toMatchObject({
      organizationId: ORGANIZATION_ID,
      adminAccountId: ADMIN_ACCOUNT_ID,
      loginName: 'acct-admin-01',
      nickname: '二级管理员',
      mustChangePassword: true,
    });
    expect(result.temporaryPassword).toMatch(/^Aa1!/);
    expect(harness.accountService.updateAccountPasswordHash).toHaveBeenCalledWith({
      accountId: ADMIN_ACCOUNT_ID,
      passwordHash: expect.any(String),
      transactionContext: harness.transactions.txContext,
      setMustChangePassword: true,
      incrementCredentialVersion: true,
    });
    const auditArg = harness.managementAuditService.append.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(auditArg).toMatchObject({
      actorAccountId: 30,
      actorAdminLevel: 1,
      organizationId: ORGANIZATION_ID,
      targetAccountId: ADMIN_ACCOUNT_ID,
      operation: 'REISSUE_LEVEL2_CREDENTIAL',
      transactionContext: harness.transactions.txContext,
      loginNameMasked: 'a***1',
    });
    // 审计与日志不得包含新口令或哈希
    expect(JSON.stringify(auditArg)).not.toContain(result.temporaryPassword);
    expect(JSON.stringify(harness.logger.info.mock.calls)).not.toContain(result.temporaryPassword);
    expect(harness.transactions.isCommitted()).toBe(true);
  });

  it('已完成首次改密的目标拒绝补发，不写哈希、不写审计', async () => {
    harness.accountService.lockMyAccountCredentialSnapshot.mockResolvedValue(
      credentialSnapshot({ mustChangePassword: false }),
    );

    await expect(
      usecase.execute({ session: levelOneSession, organizationId: ORGANIZATION_ID }),
    ).rejects.toMatchObject({ code: ORGANIZATION_MANAGEMENT_ERROR.CREDENTIAL_REISSUE_NOT_ALLOWED });

    expect(harness.accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
    expect(harness.managementAuditService.append).not.toHaveBeenCalled();
  });

  it('未绑定公司拒绝补发（ADMIN_BINDING_REQUIRED）', async () => {
    harness.organizationMembershipQueryService.listMembershipsByOrganization.mockResolvedValue([]);
    harness.adminUserQueryService.findAdminBindingCandidateFacts.mockResolvedValue(new Map());

    await expect(
      usecase.execute({ session: levelOneSession, organizationId: ORGANIZATION_ID }),
    ).rejects.toMatchObject({ code: ORGANIZATION_MANAGEMENT_ERROR.ADMIN_BINDING_REQUIRED });
    expect(harness.accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
  });

  it('账号停用的绑定拒绝补发', async () => {
    harness.adminUserQueryService.findAdminBindingCandidateFacts.mockResolvedValue(
      new Map([[ADMIN_ACCOUNT_ID, candidateFacts({ accountStatus: AccountStatus.SUSPENDED })]]),
    );

    await expect(
      usecase.execute({ session: levelOneSession, organizationId: ORGANIZATION_ID }),
    ).rejects.toMatchObject({ code: ORGANIZATION_MANAGEMENT_ERROR.CREDENTIAL_REISSUE_NOT_ALLOWED });
  });

  it('审计写入失败时整事务回滚，不返回成功', async () => {
    harness.managementAuditService.append.mockRejectedValue(new Error('audit down'));

    await expect(
      usecase.execute({ session: levelOneSession, organizationId: ORGANIZATION_ID }),
    ).rejects.toMatchObject({ code: ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED });

    expect(harness.transactions.isRolledBack()).toBe(true);
    expect(harness.transactions.isCommitted()).toBe(false);
  });

  it('二级管理员拒绝，且不开事务、不读库', async () => {
    await expect(
      usecase.execute({ session: levelTwoSession, organizationId: ORGANIZATION_ID }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

    expect(harness.transactions.runMock).not.toHaveBeenCalled();
    expect(harness.organizationQueryService.lockAdminOrganizationForUpdate).not.toHaveBeenCalled();
  });
});

describe('ResetLevelTwoCredentialUsecase', () => {
  let harness: Harness;
  let usecase: ResetLevelTwoCredentialUsecase;

  beforeEach(() => {
    harness = createHarness();
    usecase = buildReset(harness);
  });

  it('已首次改密的合法目标可重置，审计带原因且不含口令', async () => {
    harness.accountService.lockMyAccountCredentialSnapshot.mockResolvedValue(
      credentialSnapshot({ mustChangePassword: false }),
    );

    const result = await usecase.execute({
      session: levelOneSession,
      organizationId: ORGANIZATION_ID,
      adminAccountId: ADMIN_ACCOUNT_ID,
      reason: '  管理员遗忘密码  ',
    });

    expect(result.temporaryPassword).toMatch(/^Aa1!/);
    expect(harness.accountService.updateAccountPasswordHash).toHaveBeenCalledWith({
      accountId: ADMIN_ACCOUNT_ID,
      passwordHash: expect.any(String),
      transactionContext: harness.transactions.txContext,
      setMustChangePassword: true,
      incrementCredentialVersion: true,
    });
    const auditArg = harness.managementAuditService.append.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(auditArg).toMatchObject({
      operation: 'RESET_LEVEL2_CREDENTIAL',
      reason: '管理员遗忘密码',
      loginNameMasked: 'a***1',
    });
    expect(JSON.stringify(auditArg)).not.toContain(result.temporaryPassword);
  });

  it('账号 ID 与绑定事实不一致时拒绝（防止错组织/错目标）', async () => {
    await expect(
      usecase.execute({
        session: levelOneSession,
        organizationId: ORGANIZATION_ID,
        adminAccountId: 999,
        reason: '管理员遗忘密码',
      }),
    ).rejects.toMatchObject({ code: ORGANIZATION_MANAGEMENT_ERROR.ADMIN_BINDING_REQUIRED });

    expect(harness.accountService.updateAccountPasswordHash).not.toHaveBeenCalled();
  });

  it('原因为空时按输入错误拒绝，不开事务', async () => {
    await expect(
      usecase.execute({
        session: levelOneSession,
        organizationId: ORGANIZATION_ID,
        adminAccountId: ADMIN_ACCOUNT_ID,
        reason: '   ',
      }),
    ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY });

    expect(harness.transactions.runMock).not.toHaveBeenCalled();
  });

  it('公司停用时拒绝重置', async () => {
    harness.organizationQueryService.lockAdminOrganizationForUpdate.mockResolvedValue(
      organization({ status: 'DISABLED' }),
    );

    await expect(
      usecase.execute({
        session: levelOneSession,
        organizationId: ORGANIZATION_ID,
        adminAccountId: ADMIN_ACCOUNT_ID,
        reason: '管理员遗忘密码',
      }),
    ).rejects.toMatchObject({ code: ORGANIZATION_MANAGEMENT_ERROR.CREDENTIAL_REISSUE_NOT_ALLOWED });
  });

  it('非受管公司拒绝重置（ADMIN_BINDING_REQUIRED）', async () => {
    harness.organizationQueryService.lockAdminOrganizationForUpdate.mockResolvedValue(
      organization({ isManagedCompany: false }),
    );

    await expect(
      usecase.execute({
        session: levelOneSession,
        organizationId: ORGANIZATION_ID,
        adminAccountId: ADMIN_ACCOUNT_ID,
        reason: '管理员遗忘密码',
      }),
    ).rejects.toMatchObject({ code: ORGANIZATION_MANAGEMENT_ERROR.ADMIN_BINDING_REQUIRED });
  });
});
