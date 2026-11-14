import {
  AccountStatus,
  AudienceTypeEnum,
  IdentityTypeEnum,
  LoginTypeEnum,
} from '@app-types/models/account.types';
import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import { UserState } from '@app-types/models/user-info.types';
import { AUTH_ERROR } from '@core/common/errors';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { EngineerRegistrationQueryService } from '@src/modules/lithography/queries/engineer-registration.query.service';
import type { PinoLogger } from 'nestjs-pino';
import { DecideLoginRoleUsecase } from './decide-login-role.usecase';
import { EnrichLoginWithIdentityUsecase } from './enrich-login-with-identity.usecase';
import { ExecuteLoginFlowUsecase } from './execute-login-flow.usecase';
import { LoginWithPasswordUsecase } from './login-with-password.usecase';
import { TokenHelper } from '@modules/auth/token.helper';

describe('LoginWithPasswordUsecase（注册审核前的登录阻断）', () => {
  const accountQueryService = {
    findCredentialByLoginName: jest.fn(),
    findSessionAuthoritySnapshot: jest.fn(),
  } as unknown as AccountQueryService;
  const engineerRegistrationQueryService = {
    findLatestByAccountId: jest.fn(),
  } as unknown as EngineerRegistrationQueryService;
  const executeLoginFlowUsecase = {
    execute: jest.fn(),
  } as unknown as ExecuteLoginFlowUsecase;
  const decideLoginRoleUsecase = {
    execute: jest.fn(),
  } as unknown as DecideLoginRoleUsecase;
  const enrichLoginWithIdentityUsecase = {
    execute: jest.fn(),
  } as unknown as EnrichLoginWithIdentityUsecase;
  const tokenHelper = {
    generateAccessToken: jest.fn(),
  } as unknown as TokenHelper;
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as PinoLogger;
  const usecase = new LoginWithPasswordUsecase(
    accountQueryService,
    engineerRegistrationQueryService,
    executeLoginFlowUsecase,
    decideLoginRoleUsecase,
    enrichLoginWithIdentityUsecase,
    tokenHelper,
    logger,
  );

  const credential = (status: AccountStatus) => ({
    id: 9001,
    status,
    loginEmail: 'engineer-pending@example.com',
    loginPassword: 'hashed-secret',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });

  const authoritySnapshot = (
    status: AccountStatus,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    accountId: 9001,
    accountStatus: status,
    identityHint: IdentityTypeEnum.ENGINEER,
    mustChangePassword: false,
    adminLevel: null,
    userInfo: {
      userState: status === AccountStatus.PENDING ? UserState.PENDING : UserState.ACTIVE,
      accessGroup: [IdentityTypeEnum.ENGINEER],
      metaDigest: [IdentityTypeEnum.ENGINEER],
      customerOrganizationId: null,
    },
    ...overrides,
  });

  const login = (allowRestrictedSession?: boolean) =>
    usecase.execute({
      loginName: 'engineer-pending@example.com',
      loginPassword: 'PlainPassword1!',
      type: LoginTypeEnum.PASSWORD,
      ip: '127.0.0.1',
      audience: AudienceTypeEnum.SJWEB,
      allowRestrictedSession,
    });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(AccountService, 'verifyPassword').mockReturnValue(true);
    (accountQueryService.findSessionAuthoritySnapshot as jest.Mock).mockResolvedValue(
      authoritySnapshot(AccountStatus.ACTIVE),
    );
    (engineerRegistrationQueryService.findLatestByAccountId as jest.Mock).mockResolvedValue(null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['待审工程师（PENDING）', AccountStatus.PENDING],
    ['未激活（INACTIVE）', AccountStatus.INACTIVE],
    ['已停用（SUSPENDED）', AccountStatus.SUSPENDED],
  ])('%s 账号在未开启受限会话时被拒绝', async (_label, status) => {
    (accountQueryService.findCredentialByLoginName as jest.Mock).mockResolvedValue(
      credential(status),
    );
    (accountQueryService.findSessionAuthoritySnapshot as jest.Mock).mockResolvedValue(
      authoritySnapshot(status),
    );

    await expect(login()).rejects.toMatchObject({ code: AUTH_ERROR.ACCOUNT_INACTIVE });
    expect(executeLoginFlowUsecase.execute).not.toHaveBeenCalled();
    expect(decideLoginRoleUsecase.execute).not.toHaveBeenCalled();
    expect(tokenHelper.generateAccessToken).not.toHaveBeenCalled();
  });

  it('账号不存在时统一按 ACCOUNT_NOT_FOUND 拒绝', async () => {
    (accountQueryService.findCredentialByLoginName as jest.Mock).mockResolvedValue(null);

    await expect(login()).rejects.toMatchObject({ code: AUTH_ERROR.ACCOUNT_NOT_FOUND });
    expect(executeLoginFlowUsecase.execute).not.toHaveBeenCalled();
  });

  it('激活账号但必须改密时，未开启受限会话仍被拒绝', async () => {
    (accountQueryService.findCredentialByLoginName as jest.Mock).mockResolvedValue(
      credential(AccountStatus.ACTIVE),
    );
    (accountQueryService.findSessionAuthoritySnapshot as jest.Mock).mockResolvedValue(
      authoritySnapshot(AccountStatus.ACTIVE, { mustChangePassword: true }),
    );

    await expect(login()).rejects.toMatchObject({ code: AUTH_ERROR.ACCOUNT_INACTIVE });
  });

  it('停用账号即使开启受限会话也被拒绝，避免签发必被复核拒绝的令牌', async () => {
    (accountQueryService.findCredentialByLoginName as jest.Mock).mockResolvedValue(
      credential(AccountStatus.SUSPENDED),
    );
    (accountQueryService.findSessionAuthoritySnapshot as jest.Mock).mockResolvedValue(
      authoritySnapshot(AccountStatus.SUSPENDED, { mustChangePassword: true }),
    );

    await expect(login(true)).rejects.toMatchObject({ code: AUTH_ERROR.ACCOUNT_INACTIVE });
    expect(tokenHelper.generateAccessToken).not.toHaveBeenCalled();
  });

  it('资料状态停用时即使账号激活且必须改密也拒绝', async () => {
    (accountQueryService.findCredentialByLoginName as jest.Mock).mockResolvedValue(
      credential(AccountStatus.ACTIVE),
    );
    (accountQueryService.findSessionAuthoritySnapshot as jest.Mock).mockResolvedValue(
      authoritySnapshot(AccountStatus.ACTIVE, {
        mustChangePassword: true,
        userInfo: {
          userState: UserState.SUSPENDED,
          accessGroup: [IdentityTypeEnum.ENGINEER],
          metaDigest: [IdentityTypeEnum.ENGINEER],
          customerOrganizationId: null,
        },
      }),
    );

    await expect(login(true)).rejects.toMatchObject({ code: AUTH_ERROR.ACCOUNT_INACTIVE });
    expect(tokenHelper.generateAccessToken).not.toHaveBeenCalled();
  });

  it('激活账号密码错误仍按 INVALID_PASSWORD 拒绝', async () => {
    (accountQueryService.findCredentialByLoginName as jest.Mock).mockResolvedValue(
      credential(AccountStatus.ACTIVE),
    );
    jest.spyOn(AccountService, 'verifyPassword').mockReturnValue(false);

    await expect(login()).rejects.toMatchObject({ code: AUTH_ERROR.INVALID_PASSWORD });
    expect(executeLoginFlowUsecase.execute).not.toHaveBeenCalled();
  });

  it('开启受限会话后待审工程师可登录，并返回 ENGINEER_PENDING 与身份扩展', async () => {
    (accountQueryService.findCredentialByLoginName as jest.Mock).mockResolvedValue(
      credential(AccountStatus.PENDING),
    );
    (accountQueryService.findSessionAuthoritySnapshot as jest.Mock).mockResolvedValue(
      authoritySnapshot(AccountStatus.PENDING, { adminLevel: 2 }),
    );
    (executeLoginFlowUsecase.execute as jest.Mock).mockResolvedValue({
      tokens: { accessToken: 'basic-access', refreshToken: 'refresh' },
      accountId: 9001,
      roleFromHint: IdentityTypeEnum.ENGINEER,
      accessGroup: [IdentityTypeEnum.ENGINEER],
      account: {
        id: 9001,
        loginName: 'engineer-pending',
        loginEmail: 'engineer-pending@example.com',
        status: AccountStatus.PENDING,
        identityHint: IdentityTypeEnum.ENGINEER,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
      userInfo: {
        id: 1,
        accountId: 9001,
        nickname: '待审工程师',
        avatarUrl: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    (decideLoginRoleUsecase.execute as jest.Mock).mockReturnValue({
      finalRole: IdentityTypeEnum.ENGINEER,
      reason: 'hint',
    });
    (tokenHelper.generateAccessToken as jest.Mock).mockReturnValue('access-token');
    (enrichLoginWithIdentityUsecase.execute as jest.Mock).mockImplementation(
      (input: {
        finalRole: IdentityTypeEnum;
        accessGroup: IdentityTypeEnum[];
        restriction?: SessionRestriction;
        adminLevel?: number | null;
        customerOrganizationId?: number | null;
      }) => ({
        accessToken: 'access-token',
        refreshToken: 'refresh',
        accountId: 9001,
        role: input.finalRole,
        identity: null,
        accessGroup: input.accessGroup,
        restriction: input.restriction,
        adminLevel: input.adminLevel,
        customerOrganizationId: input.customerOrganizationId,
      }),
    );

    const result = await usecase.execute({
      loginName: 'engineer-pending@example.com',
      loginPassword: 'PlainPassword1!',
      type: LoginTypeEnum.PASSWORD,
      ip: '127.0.0.1',
      audience: AudienceTypeEnum.SJWEB,
      allowRestrictedSession: true,
    });

    expect(result.restriction).toBe(SessionRestriction.ENGINEER_PENDING);
    expect(result.adminLevel).toBe(2);
    expect(executeLoginFlowUsecase.execute).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 9001, allowPendingAccount: true }),
    );
    expect(tokenHelper.generateAccessToken).toHaveBeenCalled();
  });

  it('普通会话登录时不允许 PENDING 账号通过执行流程', async () => {
    (accountQueryService.findCredentialByLoginName as jest.Mock).mockResolvedValue(
      credential(AccountStatus.ACTIVE),
    );
    (accountQueryService.findSessionAuthoritySnapshot as jest.Mock).mockResolvedValue(
      authoritySnapshot(AccountStatus.ACTIVE),
    );
    (executeLoginFlowUsecase.execute as jest.Mock).mockResolvedValue({
      tokens: { accessToken: 'basic-access', refreshToken: 'refresh' },
      accountId: 9001,
      roleFromHint: IdentityTypeEnum.ENGINEER,
      accessGroup: [IdentityTypeEnum.ENGINEER],
      account: {
        id: 9001,
        loginName: 'engineer-active',
        loginEmail: 'engineer-active@example.com',
        status: AccountStatus.ACTIVE,
        identityHint: IdentityTypeEnum.ENGINEER,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
      userInfo: {
        id: 1,
        accountId: 9001,
        nickname: '工程师',
        avatarUrl: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    (decideLoginRoleUsecase.execute as jest.Mock).mockReturnValue({
      finalRole: IdentityTypeEnum.ENGINEER,
      reason: 'hint',
    });
    (tokenHelper.generateAccessToken as jest.Mock).mockReturnValue('access-token');
    (enrichLoginWithIdentityUsecase.execute as jest.Mock).mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh',
      accountId: 9001,
      role: IdentityTypeEnum.ENGINEER,
      restriction: SessionRestriction.NONE,
    });

    await usecase.execute({
      loginName: 'engineer-active@example.com',
      loginPassword: 'PlainPassword1!',
      type: LoginTypeEnum.PASSWORD,
      ip: '127.0.0.1',
      audience: AudienceTypeEnum.SJWEB,
    });

    expect(executeLoginFlowUsecase.execute).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 9001, allowPendingAccount: false }),
    );
  });
});
