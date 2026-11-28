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
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import type { PinoLogger } from 'nestjs-pino';
import { DecideLoginRoleUsecase } from './decide-login-role.usecase';
import { EnrichLoginWithIdentityUsecase } from './enrich-login-with-identity.usecase';
import { ExecuteLoginFlowUsecase } from './execute-login-flow.usecase';
import { LoginWithPasswordUsecase } from './login-with-password.usecase';
import { ResolveSessionRestrictionUsecase } from './resolve-session-restriction.usecase';
import { TokenHelper } from '@modules/auth/token.helper';

describe('LoginWithPasswordUsecase（注册审核前的登录阻断）', () => {
  const accountQueryService = {
    findCredentialByLoginName: jest.fn(),
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
    decodeToken: jest.fn(),
  } as unknown as TokenHelper;
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as PinoLogger;
  const usecase = new LoginWithPasswordUsecase(
    accountQueryService,
    resolveSessionRestrictionUsecase,
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
    credentialVersion: 0,
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
    credentialVersion: 0,
    adminLevel: null,
    userInfo: {
      userState: status === AccountStatus.PENDING ? UserState.PENDING : UserState.ACTIVE,
      accessGroup: [IdentityTypeEnum.ENGINEER],
      metaDigest: [IdentityTypeEnum.ENGINEER],
      customerOrganizationId: null,
    },
    ...overrides,
  });

  const login = (allowRestrictedSession?: boolean, accessTokenTtl?: string) =>
    usecase.execute({
      loginName: 'engineer-pending@example.com',
      loginPassword: 'PlainPassword1!',
      type: LoginTypeEnum.PASSWORD,
      ip: '127.0.0.1',
      audience: AudienceTypeEnum.SJWEB,
      allowRestrictedSession,
      ...(accessTokenTtl ? { accessTokenTtl } : {}),
    });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(AccountService, 'verifyPassword').mockReturnValue(true);
    (accountQueryService.findSessionAuthoritySnapshot as jest.Mock).mockResolvedValue(
      authoritySnapshot(AccountStatus.ACTIVE),
    );
    (engineerRegistrationQueryService.findLatestByAccountId as jest.Mock).mockResolvedValue(null);
    (
      organizationMembershipQueryService.listActiveMembershipsByAccount as jest.Mock
    ).mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * 浏览器会话入口按次指定有效期：只在网页登录传入时覆盖本次签名，
   * 其余入口不传，签名继续沿用全局 JWT_EXPIRES_IN。
   */
  describe('网页登录按次有效期（accessTokenTtl）', () => {
    const arrangeSuccessfulLogin = () => {
      (accountQueryService.findCredentialByLoginName as jest.Mock).mockResolvedValue(
        credential(AccountStatus.ACTIVE),
      );
      (executeLoginFlowUsecase.execute as jest.Mock).mockResolvedValue({
        tokens: { accessToken: 'basic-access', refreshToken: 'refresh-token' },
        credentialVersion: 0,
        accountId: 9001,
        roleFromHint: IdentityTypeEnum.ENGINEER,
        accessGroup: [IdentityTypeEnum.ENGINEER],
        account: {
          id: 9001,
          loginName: 'engineer-pending',
          loginEmail: 'engineer-pending@example.com',
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
      (tokenHelper.generateAccessToken as jest.Mock).mockReturnValue('signed-access-token');
      (enrichLoginWithIdentityUsecase.execute as jest.Mock).mockResolvedValue({
        accessToken: 'signed-access-token',
        refreshToken: 'refresh-token',
        accountId: 9001,
        role: IdentityTypeEnum.ENGINEER,
        restriction: SessionRestriction.NONE,
        adminLevel: null,
      });
    };

    it('未传入时不给签名选项加 expiresIn，回传令牌自身到期时刻', async () => {
      arrangeSuccessfulLogin();
      (tokenHelper.decodeToken as jest.Mock).mockReturnValue({ exp: 1_893_456_000 });

      const result = await login(true);

      expect(tokenHelper.generateAccessToken).toHaveBeenCalledWith({
        payload: expect.any(Object),
        audience: AudienceTypeEnum.SJWEB,
      });
      expect(result.accessTokenExpiresAt).toEqual(new Date(1_893_456_000 * 1000));
    });

    it('传入时按次覆盖 expiresIn，且不影响受众与其他签发参数', async () => {
      arrangeSuccessfulLogin();
      (tokenHelper.decodeToken as jest.Mock).mockReturnValue({ exp: 1_893_456_000 });

      await login(true, '8h');

      expect(tokenHelper.generateAccessToken).toHaveBeenCalledWith({
        payload: expect.any(Object),
        audience: AudienceTypeEnum.SJWEB,
        expiresIn: '8h',
      });
    });

    it('无法解析 exp 时回传 null，交由适配器失败关闭', async () => {
      arrangeSuccessfulLogin();
      (tokenHelper.decodeToken as jest.Mock).mockReturnValue(null);

      const result = await login(true, '8h');

      expect(result.accessTokenExpiresAt).toBeNull();
    });
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

  it.each([
    ['账号 ACTIVE / 资料 PENDING', AccountStatus.ACTIVE, UserState.PENDING],
    ['账号 PENDING / 资料 ACTIVE', AccountStatus.PENDING, UserState.ACTIVE],
  ])(
    '%s 的单边状态即使存在限制且允许受限会话也拒绝签发令牌',
    async (_label, accountStatus, userState) => {
      (accountQueryService.findCredentialByLoginName as jest.Mock).mockResolvedValue(
        credential(accountStatus),
      );
      (accountQueryService.findSessionAuthoritySnapshot as jest.Mock).mockResolvedValue(
        authoritySnapshot(accountStatus, {
          userInfo: {
            userState,
            accessGroup: [IdentityTypeEnum.ENGINEER],
            metaDigest: [IdentityTypeEnum.ENGINEER],
            customerOrganizationId: null,
          },
        }),
      );
      (engineerRegistrationQueryService.findLatestByAccountId as jest.Mock).mockResolvedValue({
        status: 'PENDING',
        organizationId: 501,
      });

      await expect(login(true)).rejects.toMatchObject({ code: AUTH_ERROR.ACCOUNT_INACTIVE });
      expect(executeLoginFlowUsecase.execute).not.toHaveBeenCalled();
      expect(tokenHelper.generateAccessToken).not.toHaveBeenCalled();
    },
  );

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
      credentialVersion: 0,
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

  it('已批准但缺少有效工程师成员时，普通登录仍被拒绝', async () => {
    (accountQueryService.findCredentialByLoginName as jest.Mock).mockResolvedValue(
      credential(AccountStatus.ACTIVE),
    );
    (accountQueryService.findSessionAuthoritySnapshot as jest.Mock).mockResolvedValue(
      authoritySnapshot(AccountStatus.ACTIVE),
    );
    (engineerRegistrationQueryService.findLatestByAccountId as jest.Mock).mockResolvedValue({
      status: 'APPROVED',
      organizationId: 501,
    });

    await expect(login()).rejects.toMatchObject({ code: AUTH_ERROR.ACCOUNT_INACTIVE });
    expect(tokenHelper.generateAccessToken).not.toHaveBeenCalled();
  });

  it('已批准且成员资格有效时按普通会话放行', async () => {
    (accountQueryService.findCredentialByLoginName as jest.Mock).mockResolvedValue(
      credential(AccountStatus.ACTIVE),
    );
    (accountQueryService.findSessionAuthoritySnapshot as jest.Mock).mockResolvedValue(
      authoritySnapshot(AccountStatus.ACTIVE),
    );
    (engineerRegistrationQueryService.findLatestByAccountId as jest.Mock).mockResolvedValue({
      status: 'APPROVED',
      organizationId: 501,
    });
    (
      organizationMembershipQueryService.listActiveMembershipsByAccount as jest.Mock
    ).mockResolvedValue([{ organizationId: 501, memberRole: IdentityTypeEnum.ENGINEER }]);
    (executeLoginFlowUsecase.execute as jest.Mock).mockResolvedValue({
      tokens: { accessToken: 'basic-access', refreshToken: 'refresh' },
      credentialVersion: 0,
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
    (enrichLoginWithIdentityUsecase.execute as jest.Mock).mockImplementation(
      (input: { restriction?: SessionRestriction }) => ({
        accessToken: 'access-token',
        refreshToken: 'refresh',
        accountId: 9001,
        role: IdentityTypeEnum.ENGINEER,
        restriction: input.restriction,
        engineerOrganizationId: 501,
      }),
    );

    const result = await usecase.execute({
      loginName: 'engineer-active@example.com',
      loginPassword: 'PlainPassword1!',
      type: LoginTypeEnum.PASSWORD,
      ip: '127.0.0.1',
      audience: AudienceTypeEnum.SJWEB,
    });

    expect(result.restriction).toBe(SessionRestriction.NONE);
    expect(result.engineerOrganizationId).toBe(501);
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
      credentialVersion: 0,
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
  describe('密码验证与令牌签发绑定同一凭据版本', () => {
    const prepareVersions = (
      verifiedVersion: number,
      authorityVersion: number,
      basicVersion: number,
    ) => {
      (accountQueryService.findCredentialByLoginName as jest.Mock).mockResolvedValue({
        ...credential(AccountStatus.ACTIVE),
        credentialVersion: verifiedVersion,
      });
      (accountQueryService.findSessionAuthoritySnapshot as jest.Mock).mockResolvedValue(
        authoritySnapshot(AccountStatus.ACTIVE, { credentialVersion: authorityVersion }),
      );
      (executeLoginFlowUsecase.execute as jest.Mock).mockResolvedValue({
        accountId: 9001,
        credentialVersion: basicVersion,
        tokens: { accessToken: 'basic-access', refreshToken: 'refresh' },
        accessGroup: [IdentityTypeEnum.ENGINEER],
        account: { loginEmail: 'engineer@example.com' },
        userInfo: { nickname: '工程师' },
      });
      (decideLoginRoleUsecase.execute as jest.Mock).mockReturnValue({
        finalRole: IdentityTypeEnum.ENGINEER,
        reason: 'hint',
      });
      (tokenHelper.generateAccessToken as jest.Mock).mockReturnValue('access-token');
      (enrichLoginWithIdentityUsecase.execute as jest.Mock).mockResolvedValue({
        accessToken: 'access-token',
      });
    };

    it('凭据读取后发生重置，授权快照版本变化时拒绝旧密码登录', async () => {
      prepareVersions(4, 5, 5);
      await expect(login()).rejects.toMatchObject({ code: AUTH_ERROR.INVALID_PASSWORD });
      expect(AccountService.verifyPassword).toHaveBeenCalled();
      expect(executeLoginFlowUsecase.execute).not.toHaveBeenCalled();
      expect(tokenHelper.generateAccessToken).not.toHaveBeenCalled();
    });

    it('密码验证后发生重置，基础登录版本变化时不返回新代次令牌', async () => {
      prepareVersions(4, 4, 5);
      await expect(login()).rejects.toMatchObject({ code: AUTH_ERROR.INVALID_PASSWORD });
      expect(executeLoginFlowUsecase.execute).toHaveBeenCalledTimes(1);
      expect(tokenHelper.generateAccessToken).not.toHaveBeenCalled();
      expect(enrichLoginWithIdentityUsecase.execute).not.toHaveBeenCalled();
    });

    it('版本一致时以实际验证通过的非零版本签发', async () => {
      prepareVersions(4, 4, 4);
      await expect(login()).resolves.toMatchObject({ accessToken: 'access-token' });
      expect(tokenHelper.generateAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ sub: 9001, credentialVersion: 4 }),
        }),
      );
    });
  });
});
