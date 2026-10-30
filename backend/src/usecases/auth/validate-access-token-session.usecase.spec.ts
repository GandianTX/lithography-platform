import type { JwtPayload } from '@app-types/jwt.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import type { AccountSessionAuthoritySnapshot } from '@src/modules/account/account.types';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { PinoLogger } from 'nestjs-pino';
import { ValidateAccessTokenSessionUsecase } from './validate-access-token-session.usecase';

describe('ValidateAccessTokenSessionUsecase', () => {
  const snapshot = (
    overrides: Partial<AccountSessionAuthoritySnapshot> = {},
  ): AccountSessionAuthoritySnapshot => ({
    accountId: 7,
    accountStatus: AccountStatus.ACTIVE,
    identityHint: IdentityTypeEnum.ENGINEER,
    userInfo: {
      userState: UserState.ACTIVE,
      accessGroup: [IdentityTypeEnum.ENGINEER],
      metaDigest: [IdentityTypeEnum.ENGINEER],
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
  const logger = {
    setContext: jest.fn(),
    warn: jest.fn(),
  } as unknown as PinoLogger;
  const usecase = new ValidateAccessTokenSessionUsecase(accountQueryService, logger);

  beforeEach(() => {
    jest.clearAllMocks();
    (accountQueryService.findSessionAuthoritySnapshot as jest.Mock).mockResolvedValue(snapshot());
  });

  it('允许合法单角色会话', async () => {
    await expect(usecase.execute({ payload: payload() })).resolves.toEqual(payload());
  });

  it('允许 accessGroup 与 metaDigest 一致的历史混合角色会话', async () => {
    (accountQueryService.findSessionAuthoritySnapshot as jest.Mock).mockResolvedValue(
      snapshot({
        identityHint: IdentityTypeEnum.SUPER_ADMIN,
        userInfo: {
          userState: UserState.ACTIVE,
          accessGroup: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
          metaDigest: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
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
    (accountQueryService.findSessionAuthoritySnapshot as jest.Mock).mockResolvedValue(
      snapshot({
        identityHint: IdentityTypeEnum.SUPER_ADMIN,
        userInfo: {
          userState: UserState.ACTIVE,
          accessGroup: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
          metaDigest: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
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
      snapshot({ userInfo: { userState: UserState.ACTIVE, accessGroup: [], metaDigest: [] } }),
      payload({ accessGroup: [] }),
    ],
    [
      '三源集合不一致',
      snapshot({
        userInfo: {
          userState: UserState.ACTIVE,
          accessGroup: [IdentityTypeEnum.ENGINEER],
          metaDigest: [IdentityTypeEnum.CUSTOMER],
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
        },
      }),
      payload(),
    ],
    ['Token 角色不一致', snapshot(), payload({ accessGroup: [IdentityTypeEnum.CUSTOMER] })],
  ])('%s 仍失败关闭为 JWT 认证失败', async (_label, authoritySnapshot, token) => {
    (accountQueryService.findSessionAuthoritySnapshot as jest.Mock).mockResolvedValue(
      authoritySnapshot,
    );
    await expect(usecase.execute({ payload: token })).rejects.toMatchObject({
      code: 'JWT_AUTHENTICATION_FAILED',
    });
  });

  it.each([
    ['账号停用', snapshot({ accountStatus: AccountStatus.SUSPENDED })],
    ['账号待审（PENDING）', snapshot({ accountStatus: AccountStatus.PENDING })],
    [
      '资料待审（userState PENDING）',
      snapshot({
        userInfo: {
          userState: UserState.PENDING,
          accessGroup: [IdentityTypeEnum.ENGINEER],
          metaDigest: [IdentityTypeEnum.ENGINEER],
        },
      }),
    ],
    [
      '角色从 ENGINEER 改为 CUSTOMER',
      snapshot({
        identityHint: IdentityTypeEnum.CUSTOMER,
        userInfo: {
          userState: UserState.ACTIVE,
          accessGroup: [IdentityTypeEnum.CUSTOMER],
          metaDigest: [IdentityTypeEnum.CUSTOMER],
        },
      }),
    ],
  ])('%s 时旧 Token 立即失效', async (_label, authoritySnapshot) => {
    (accountQueryService.findSessionAuthoritySnapshot as jest.Mock).mockResolvedValue(
      authoritySnapshot,
    );
    await expect(usecase.execute({ payload: payload() })).rejects.toMatchObject({
      code: 'JWT_AUTHENTICATION_FAILED',
    });
  });
});
