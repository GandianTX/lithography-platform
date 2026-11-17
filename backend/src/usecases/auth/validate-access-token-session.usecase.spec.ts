import type { JwtPayload } from '@app-types/jwt.types';
import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import { UserState } from '@app-types/models/user-info.types';
import type { AccountSessionAuthoritySnapshot } from '@src/modules/account/account.types';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { EngineerRegistrationQueryService } from '@src/modules/lithography/queries/engineer-registration.query.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import type { OrganizationMembershipFact } from '@src/modules/lithography/organization.types';
import type { PinoLogger } from 'nestjs-pino';
import { ResolveSessionRestrictionUsecase } from './resolve-session-restriction.usecase';
import { ValidateAccessTokenSessionUsecase } from './validate-access-token-session.usecase';

describe('ValidateAccessTokenSessionUsecase', () => {
  const snapshot = (
    overrides: Partial<AccountSessionAuthoritySnapshot> = {},
  ): AccountSessionAuthoritySnapshot => ({
    accountId: 7,
    accountStatus: AccountStatus.ACTIVE,
    identityHint: IdentityTypeEnum.ENGINEER,
    mustChangePassword: false,
    adminLevel: null,
    credentialVersion: 0,
    userInfo: {
      userState: UserState.ACTIVE,
      accessGroup: [IdentityTypeEnum.ENGINEER],
      metaDigest: [IdentityTypeEnum.ENGINEER],
      customerOrganizationId: null,
    },
    ...overrides,
  });

  const payload = (overrides: Partial<JwtPayload> = {}): JwtPayload => ({
    sub: 7,
    username: 'session-test',
    email: 'session-test@example.com',
    accessGroup: [IdentityTypeEnum.ENGINEER],
    activeRole: IdentityTypeEnum.ENGINEER,
    type: 'access',
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

  const accountQueryService = {
    findSessionAuthoritySnapshot: jest.fn(),
  } as unknown as AccountQueryService;
  const engineerRegistrationQueryService = {
    findLatestByAccountId: jest.fn(),
  } as unknown as EngineerRegistrationQueryService;
  const organizationMembershipQueryService = {
    listActiveMembershipsByAccount: jest.fn(),
  } as unknown as OrganizationMembershipQueryService;
  const resolveSessionRestrictionUsecase = new ResolveSessionRestrictionUsecase(
    engineerRegistrationQueryService,
    organizationMembershipQueryService,
  );
  const logger = {
    setContext: jest.fn(),
    warn: jest.fn(),
  } as unknown as PinoLogger;
  const usecase = new ValidateAccessTokenSessionUsecase(
    accountQueryService,
    resolveSessionRestrictionUsecase,
    logger,
  );

  const mockSnapshot = (value: AccountSessionAuthoritySnapshot): void => {
    (accountQueryService.findSessionAuthoritySnapshot as jest.Mock).mockResolvedValue(value);
  };
  const mockLatestApplication = (
    status: EngineerRegistrationApplicationStatus | null,
    organizationId: number | null = null,
  ): void => {
    (engineerRegistrationQueryService.findLatestByAccountId as jest.Mock).mockResolvedValue(
      status === null ? null : { status, organizationId },
    );
  };
  const mockMemberships = (facts: readonly OrganizationMembershipFact[]): void => {
    (
      organizationMembershipQueryService.listActiveMembershipsByAccount as jest.Mock
    ).mockResolvedValue(facts);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSnapshot(snapshot());
    mockLatestApplication(null);
    mockMemberships([]);
  });

  it('允许合法单角色会话，并返回 NONE 限制', async () => {
    await expect(usecase.execute({ payload: payload() })).resolves.toMatchObject({
      ...payload(),
      accountId: 7,
      role: IdentityTypeEnum.ENGINEER,
      adminLevel: null,
      customerOrganizationId: null,
      engineerOrganizationId: null,
      adminOrganizationId: null,
      registrationOrganizationId: null,
      restriction: SessionRestriction.NONE,
    });
  });

  it('允许 accessGroup 与 metaDigest 一致的历史混合角色会话', async () => {
    mockSnapshot(
      snapshot({
        identityHint: IdentityTypeEnum.SUPER_ADMIN,
        userInfo: {
          userState: UserState.ACTIVE,
          accessGroup: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
          metaDigest: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
          customerOrganizationId: null,
        },
      }),
    );

    await expect(
      usecase.execute({
        payload: payload({
          accessGroup: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
          activeRole: IdentityTypeEnum.ENGINEER,
        }),
      }),
    ).resolves.toBeDefined();
  });

  it('允许历史 Token 缺失 activeRole，由业务用例失败关闭', async () => {
    mockSnapshot(
      snapshot({
        identityHint: IdentityTypeEnum.SUPER_ADMIN,
        userInfo: {
          userState: UserState.ACTIVE,
          accessGroup: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
          metaDigest: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
          customerOrganizationId: null,
        },
      }),
    );

    await expect(
      usecase.execute({
        payload: payload({
          accessGroup: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
          activeRole: undefined,
        }),
      }),
    ).resolves.toBeDefined();
  });

  it.each([
    [
      '空角色',
      snapshot({
        userInfo: {
          userState: UserState.ACTIVE,
          accessGroup: [],
          metaDigest: [],
          customerOrganizationId: null,
        },
      }),
      payload({ accessGroup: [] }),
    ],
    [
      '三源集合不一致',
      snapshot({
        userInfo: {
          userState: UserState.ACTIVE,
          accessGroup: [IdentityTypeEnum.ENGINEER],
          metaDigest: [IdentityTypeEnum.CUSTOMER],
          customerOrganizationId: null,
        },
      }),
      payload(),
    ],
    [
      'identityHint 非成员',
      snapshot({
        identityHint: IdentityTypeEnum.CUSTOMER,
        userInfo: {
          userState: UserState.ACTIVE,
          accessGroup: [IdentityTypeEnum.ENGINEER],
          metaDigest: [IdentityTypeEnum.ENGINEER],
          customerOrganizationId: null,
        },
      }),
      payload(),
    ],
    ['Token 角色不一致', snapshot(), payload({ accessGroup: [IdentityTypeEnum.CUSTOMER] })],
  ])('%s 仍失败关闭为 JWT 认证失败', async (_label, authoritySnapshot, token) => {
    mockSnapshot(authoritySnapshot);
    await expect(usecase.execute({ payload: token })).rejects.toMatchObject({
      code: 'JWT_AUTHENTICATION_FAILED',
    });
  });

  it.each([
    ['账号停用', snapshot({ accountStatus: AccountStatus.SUSPENDED }), payload()],
    [
      '账号待审但无任何限制（非工程师）',
      snapshot({
        identityHint: IdentityTypeEnum.CUSTOMER,
        accountStatus: AccountStatus.PENDING,
        userInfo: {
          userState: UserState.ACTIVE,
          accessGroup: [IdentityTypeEnum.CUSTOMER],
          metaDigest: [IdentityTypeEnum.CUSTOMER],
          customerOrganizationId: null,
        },
      }),
      payload({ accessGroup: [IdentityTypeEnum.CUSTOMER], activeRole: IdentityTypeEnum.CUSTOMER }),
    ],
    [
      '角色从 ENGINEER 改为 CUSTOMER',
      snapshot({
        identityHint: IdentityTypeEnum.CUSTOMER,
        userInfo: {
          userState: UserState.ACTIVE,
          accessGroup: [IdentityTypeEnum.CUSTOMER],
          metaDigest: [IdentityTypeEnum.CUSTOMER],
          customerOrganizationId: null,
        },
      }),
      payload(),
    ],
  ])('%s 时旧 Token 立即失效', async (_label, authoritySnapshot, token) => {
    mockSnapshot(authoritySnapshot);
    await expect(usecase.execute({ payload: token })).rejects.toMatchObject({
      code: 'JWT_AUTHENTICATION_FAILED',
    });
  });

  it('待审工程师允许受限会话并返回 ENGINEER_PENDING', async () => {
    mockSnapshot(
      snapshot({
        accountStatus: AccountStatus.PENDING,
        userInfo: {
          userState: UserState.PENDING,
          accessGroup: [IdentityTypeEnum.ENGINEER],
          metaDigest: [IdentityTypeEnum.ENGINEER],
          customerOrganizationId: 9,
        },
      }),
    );

    await expect(usecase.execute({ payload: payload() })).resolves.toMatchObject({
      restriction: SessionRestriction.ENGINEER_PENDING,
      customerOrganizationId: 9,
    });
  });

  it.each([
    ['账号 ACTIVE / 资料 PENDING', AccountStatus.ACTIVE, UserState.PENDING],
    ['账号 PENDING / 资料 ACTIVE', AccountStatus.PENDING, UserState.ACTIVE],
  ])(
    '已签发 Token 遇到%s 时认证层拒绝并记录双状态不一致',
    async (_label, accountStatus, userState) => {
      mockSnapshot(
        snapshot({
          accountStatus,
          userInfo: {
            userState,
            accessGroup: [IdentityTypeEnum.ENGINEER],
            metaDigest: [IdentityTypeEnum.ENGINEER],
            customerOrganizationId: null,
          },
        }),
      );
      mockLatestApplication(EngineerRegistrationApplicationStatus.PENDING);

      await expect(usecase.execute({ payload: payload() })).rejects.toMatchObject({
        code: 'JWT_AUTHENTICATION_FAILED',
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ gate: 3, reason: 'STATUS_COMBINATION_MISMATCH' }),
        expect.any(String),
      );
    },
  );

  it.each([
    ['账号行缺失', snapshot({ accountStatus: null }), 'ACCOUNT_RECORD_MISSING'],
    ['资料行缺失', snapshot({ userInfo: null }), 'USER_INFO_RECORD_MISSING'],
  ])('%s 时认证层拒绝并记录缺行原因', async (_label, authoritySnapshot, reason) => {
    mockSnapshot(authoritySnapshot);

    await expect(usecase.execute({ payload: payload() })).rejects.toMatchObject({
      code: 'JWT_AUTHENTICATION_FAILED',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ gate: 2, reason }),
      expect.any(String),
    );
  });

  it('最新申请为 REJECTED 时返回 ENGINEER_REJECTED', async () => {
    mockSnapshot(
      snapshot({
        accountStatus: AccountStatus.PENDING,
        userInfo: {
          userState: UserState.PENDING,
          accessGroup: [IdentityTypeEnum.ENGINEER],
          metaDigest: [IdentityTypeEnum.ENGINEER],
          customerOrganizationId: null,
        },
      }),
    );
    mockLatestApplication(EngineerRegistrationApplicationStatus.REJECTED);

    await expect(usecase.execute({ payload: payload() })).resolves.toMatchObject({
      restriction: SessionRestriction.ENGINEER_REJECTED,
    });
  });

  it('must_change_password 优先于申请状态返回 MUST_CHANGE_PASSWORD', async () => {
    mockSnapshot(snapshot({ mustChangePassword: true, adminLevel: 2 }));
    mockLatestApplication(EngineerRegistrationApplicationStatus.PENDING);

    await expect(usecase.execute({ payload: payload() })).resolves.toMatchObject({
      restriction: SessionRestriction.MUST_CHANGE_PASSWORD,
      adminLevel: 2,
    });
  });

  it('申请已批准但缺少有效工程师成员关系时返回 ENGINEER_INACTIVE', async () => {
    mockLatestApplication(EngineerRegistrationApplicationStatus.APPROVED, 501);
    mockMemberships([]);

    await expect(usecase.execute({ payload: payload() })).resolves.toMatchObject({
      restriction: SessionRestriction.ENGINEER_INACTIVE,
      engineerOrganizationId: null,
      registrationOrganizationId: 501,
    });
  });

  it('申请已批准且成员组织与申请目标一致时返回 NONE 并带出可信组织', async () => {
    mockLatestApplication(EngineerRegistrationApplicationStatus.APPROVED, 501);
    mockMemberships([membership({ organizationId: 501 })]);

    await expect(usecase.execute({ payload: payload() })).resolves.toMatchObject({
      restriction: SessionRestriction.NONE,
      engineerOrganizationId: 501,
      registrationOrganizationId: 501,
    });
  });

  it('申请已批准但成员组织与申请目标不一致时返回 ENGINEER_INACTIVE', async () => {
    mockLatestApplication(EngineerRegistrationApplicationStatus.APPROVED, 501);
    mockMemberships([membership({ organizationId: 777 })]);

    await expect(usecase.execute({ payload: payload() })).resolves.toMatchObject({
      restriction: SessionRestriction.ENGINEER_INACTIVE,
      engineerOrganizationId: 777,
      registrationOrganizationId: 501,
    });
  });

  it('未声明凭据代次的旧 Token 按 0 处理，可与库内代次 0 兼容', async () => {
    mockSnapshot(snapshot({ credentialVersion: 0 }));

    await expect(usecase.execute({ payload: payload() })).resolves.toBeDefined();
  });

  it('Token 与库内凭据代次一致时放行', async () => {
    mockSnapshot(snapshot({ credentialVersion: 4 }));

    await expect(
      usecase.execute({ payload: payload({ credentialVersion: 4 }) }),
    ).resolves.toBeDefined();
  });

  it('凭据代次不一致时旧 Token 永久失效（门禁 7）', async () => {
    mockSnapshot(snapshot({ credentialVersion: 3 }));

    await expect(
      usecase.execute({ payload: payload({ credentialVersion: 2 }) }),
    ).rejects.toMatchObject({ code: 'JWT_AUTHENTICATION_FAILED' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ gate: 7, reason: 'CREDENTIAL_VERSION_MISMATCH' }),
      expect.any(String),
    );
  });
});
