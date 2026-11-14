import type { JwtPayload } from '@app-types/jwt.types';
import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import { UserState } from '@app-types/models/user-info.types';
import type { AccountSessionAuthoritySnapshot } from '@src/modules/account/account.types';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { EngineerRegistrationQueryService } from '@src/modules/lithography/queries/engineer-registration.query.service';
import type { PinoLogger } from 'nestjs-pino';
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

  const accountQueryService = {
    findSessionAuthoritySnapshot: jest.fn(),
  } as unknown as AccountQueryService;
  const engineerRegistrationQueryService = {
    findLatestByAccountId: jest.fn(),
  } as unknown as EngineerRegistrationQueryService;
  const logger = {
    setContext: jest.fn(),
    warn: jest.fn(),
  } as unknown as PinoLogger;
  const usecase = new ValidateAccessTokenSessionUsecase(
    accountQueryService,
    engineerRegistrationQueryService,
    logger,
  );

  const mockSnapshot = (value: AccountSessionAuthoritySnapshot): void => {
    (accountQueryService.findSessionAuthoritySnapshot as jest.Mock).mockResolvedValue(value);
  };
  const mockLatestApplication = (status: EngineerRegistrationApplicationStatus | null): void => {
    (engineerRegistrationQueryService.findLatestByAccountId as jest.Mock).mockResolvedValue(
      status === null ? null : { status },
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSnapshot(snapshot());
    mockLatestApplication(null);
  });

  it('允许合法单角色会话，并返回 NONE 限制', async () => {
    await expect(usecase.execute({ payload: payload() })).resolves.toMatchObject({
      ...payload(),
      accountId: 7,
      role: IdentityTypeEnum.ENGINEER,
      adminLevel: null,
      customerOrganizationId: null,
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
});
