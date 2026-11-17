// src/usecases/auth/resolve-session-restriction.usecase.spec.ts

import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import { UserState } from '@app-types/models/user-info.types';
import type { AccountSessionAuthoritySnapshot } from '@src/modules/account/account.types';
import type { EngineerRegistrationApplicationSnapshot } from '@src/modules/lithography/engineer-registration.types';
import type { OrganizationMembershipFact } from '@src/modules/lithography/organization.types';
import { EngineerRegistrationQueryService } from '@src/modules/lithography/queries/engineer-registration.query.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { ResolveSessionRestrictionUsecase } from './resolve-session-restriction.usecase';

describe('ResolveSessionRestrictionUsecase', () => {
  const engineerRegistrationQueryService = {
    findLatestByAccountId: jest.fn(),
  } as unknown as EngineerRegistrationQueryService;
  const organizationMembershipQueryService = {
    listActiveMembershipsByAccount: jest.fn(),
  } as unknown as OrganizationMembershipQueryService;
  const usecase = new ResolveSessionRestrictionUsecase(
    engineerRegistrationQueryService,
    organizationMembershipQueryService,
  );

  const snapshot = (
    overrides: Partial<AccountSessionAuthoritySnapshot> = {},
  ): AccountSessionAuthoritySnapshot => ({
    accountId: 7,
    accountStatus: AccountStatus.ACTIVE,
    identityHint: IdentityTypeEnum.ENGINEER,
    mustChangePassword: false,
    credentialVersion: 0,
    adminLevel: null,
    userInfo: {
      userState: UserState.ACTIVE,
      accessGroup: [IdentityTypeEnum.ENGINEER],
      metaDigest: [IdentityTypeEnum.ENGINEER],
      customerOrganizationId: null,
    },
    ...overrides,
  });

  const membership = (
    overrides: Partial<OrganizationMembershipFact> = {},
  ): OrganizationMembershipFact => ({
    membershipId: 1,
    organizationId: 501,
    organizationCode: 'CLIENT_DEFAULT',
    organizationName: '示例维护公司',
    organizationKind: 'CLIENT',
    memberRole: IdentityTypeEnum.ENGINEER,
    ...overrides,
  });

  const application = (
    overrides: Partial<EngineerRegistrationApplicationSnapshot> = {},
  ): EngineerRegistrationApplicationSnapshot => ({
    id: 11,
    accountId: 7,
    organizationId: 501,
    status: EngineerRegistrationApplicationStatus.APPROVED,
    applicationNote: null,
    submittedAt: new Date('2026-01-01T00:00:00Z'),
    reviewedByAccountId: 1,
    reviewedAt: new Date('2026-01-02T00:00:00Z'),
    reviewComment: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (
      organizationMembershipQueryService.listActiveMembershipsByAccount as jest.Mock
    ).mockResolvedValue([]);
    (engineerRegistrationQueryService.findLatestByAccountId as jest.Mock).mockResolvedValue(null);
  });

  it('非工程师身份不读取工程师申请，避免跨身份查询', async () => {
    (
      organizationMembershipQueryService.listActiveMembershipsByAccount as jest.Mock
    ).mockResolvedValue([membership({ organizationId: 3, memberRole: IdentityTypeEnum.CUSTOMER })]);

    const result = await usecase.execute({
      accountId: 7,
      snapshot: snapshot({ identityHint: IdentityTypeEnum.CUSTOMER }),
    });

    expect(engineerRegistrationQueryService.findLatestByAccountId).not.toHaveBeenCalled();
    expect(result.latestEngineerApplication).toBeNull();
    expect(result.engineerOrganizationId).toBeNull();
  });

  it('授予唯一工程师成员组织，并保留申请目标组织', async () => {
    (engineerRegistrationQueryService.findLatestByAccountId as jest.Mock).mockResolvedValue(
      application(),
    );
    (
      organizationMembershipQueryService.listActiveMembershipsByAccount as jest.Mock
    ).mockResolvedValue([membership({ organizationId: 501 })]);

    const result = await usecase.execute({ accountId: 7, snapshot: snapshot() });

    expect(result.restriction).toBe(SessionRestriction.NONE);
    expect(result.engineerOrganizationId).toBe(501);
    expect(result.latestEngineerApplication?.organizationId).toBe(501);
  });

  it('同角色多组织成员关系视为歧义，不授予组织身份', async () => {
    (engineerRegistrationQueryService.findLatestByAccountId as jest.Mock).mockResolvedValue(
      application(),
    );
    (
      organizationMembershipQueryService.listActiveMembershipsByAccount as jest.Mock
    ).mockResolvedValue([
      membership({ membershipId: 1, organizationId: 501 }),
      membership({ membershipId: 2, organizationId: 502 }),
    ]);

    const result = await usecase.execute({ accountId: 7, snapshot: snapshot() });

    expect(result.engineerOrganizationId).toBeNull();
    expect(result.restriction).toBe(SessionRestriction.ENGINEER_INACTIVE);
  });

  it('不同角色成员关系互不干扰，各自独立授予', async () => {
    (
      organizationMembershipQueryService.listActiveMembershipsByAccount as jest.Mock
    ).mockResolvedValue([
      membership({ membershipId: 1, organizationId: 501 }),
      membership({
        membershipId: 2,
        organizationId: 900,
        memberRole: IdentityTypeEnum.SUPER_ADMIN,
      }),
      membership({
        membershipId: 3,
        organizationId: 901,
        memberRole: IdentityTypeEnum.SUPER_ADMIN,
      }),
    ]);

    const result = await usecase.execute({ accountId: 7, snapshot: snapshot() });

    expect(result.engineerOrganizationId).toBe(501);
    expect(result.adminOrganizationId).toBeNull();
  });

  it('必须改密优先于资格判定', async () => {
    (engineerRegistrationQueryService.findLatestByAccountId as jest.Mock).mockResolvedValue(
      application({ status: EngineerRegistrationApplicationStatus.PENDING }),
    );

    const result = await usecase.execute({
      accountId: 7,
      snapshot: snapshot({ mustChangePassword: true }),
    });

    expect(result.restriction).toBe(SessionRestriction.MUST_CHANGE_PASSWORD);
  });

  it('无申请记录的存量工程师维持 NONE，不追加成员要求', async () => {
    const result = await usecase.execute({ accountId: 7, snapshot: snapshot() });

    expect(result.latestEngineerApplication).toBeNull();
    expect(result.restriction).toBe(SessionRestriction.NONE);
  });

  describe('二级管理员可信公司', () => {
    const adminSnapshot = (overrides: Partial<AccountSessionAuthoritySnapshot> = {}) =>
      snapshot({
        identityHint: IdentityTypeEnum.SUPER_ADMIN,
        adminLevel: 2,
        ...overrides,
      });

    it('唯一有效 SUPER_ADMIN 成员组织时保持 NONE 并给出可信公司', async () => {
      (
        organizationMembershipQueryService.listActiveMembershipsByAccount as jest.Mock
      ).mockResolvedValue([
        membership({ organizationId: 501, memberRole: IdentityTypeEnum.SUPER_ADMIN }),
      ]);

      const result = await usecase.execute({ accountId: 7, snapshot: adminSnapshot() });

      expect(result.restriction).toBe(SessionRestriction.NONE);
      expect(result.adminOrganizationId).toBe(501);
    });

    it('公司停用或成员缺失（0 条有效成员）时返回 ADMIN_ORGANIZATION_INACTIVE', async () => {
      const result = await usecase.execute({ accountId: 7, snapshot: adminSnapshot() });

      expect(result.restriction).toBe(SessionRestriction.ADMIN_ORGANIZATION_INACTIVE);
      expect(result.adminOrganizationId).toBeNull();
    });

    it('成员角色不是 SUPER_ADMIN 时返回 ADMIN_ORGANIZATION_INACTIVE', async () => {
      (
        organizationMembershipQueryService.listActiveMembershipsByAccount as jest.Mock
      ).mockResolvedValue([membership({ organizationId: 501 })]);

      const result = await usecase.execute({ accountId: 7, snapshot: adminSnapshot() });

      expect(result.restriction).toBe(SessionRestriction.ADMIN_ORGANIZATION_INACTIVE);
    });

    it('多公司成员歧义时返回 ADMIN_ORGANIZATION_INACTIVE', async () => {
      (
        organizationMembershipQueryService.listActiveMembershipsByAccount as jest.Mock
      ).mockResolvedValue([
        membership({
          membershipId: 1,
          organizationId: 501,
          memberRole: IdentityTypeEnum.SUPER_ADMIN,
        }),
        membership({
          membershipId: 2,
          organizationId: 502,
          memberRole: IdentityTypeEnum.SUPER_ADMIN,
        }),
      ]);

      const result = await usecase.execute({ accountId: 7, snapshot: adminSnapshot() });

      expect(result.restriction).toBe(SessionRestriction.ADMIN_ORGANIZATION_INACTIVE);
      expect(result.adminOrganizationId).toBeNull();
    });

    it('一级管理员缺少成员组织时仍为 NONE', async () => {
      const result = await usecase.execute({
        accountId: 7,
        snapshot: adminSnapshot({ adminLevel: 1 }),
      });

      expect(result.restriction).toBe(SessionRestriction.NONE);
    });
  });
});
