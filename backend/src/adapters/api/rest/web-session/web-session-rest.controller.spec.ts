// src/adapters/api/rest/web-session/web-session-rest.controller.spec.ts

import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import {
  AccountStatus,
  AudienceTypeEnum,
  IdentityTypeEnum,
  LoginTypeEnum,
} from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import { DomainError, AUTH_ERROR, JWT_ERROR } from '@core/common/errors/domain-error';
import { HttpException, Logger } from '@nestjs/common';
import { TokenHelper } from '@modules/auth/token.helper';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { FetchUserInfoUsecase } from '@usecases/account/fetch-user-info.usecase';
import { LoginWithPasswordUsecase } from '@usecases/auth/login-with-password.usecase';
import { ResolveWebSessionUsecase } from '@usecases/auth/resolve-web-session.usecase';
import { DecideLoginRoleUsecase } from '@usecases/auth/decide-login-role.usecase';
import { EnrichLoginWithIdentityUsecase } from '@usecases/auth/enrich-login-with-identity.usecase';
import { ExecuteLoginFlowUsecase } from '@usecases/auth/execute-login-flow.usecase';
import { ResolveSessionRestrictionUsecase } from '@usecases/auth/resolve-session-restriction.usecase';
import type { PinoLogger } from 'nestjs-pino';
import type { Request, Response } from 'express';

import {
  WEB_SESSION_COOKIE_NAME,
  WEB_SESSION_COOKIE_PATH,
  WEB_SESSION_REST_CODES,
  type WebSessionOptions,
} from './web-session.options';
import { WebSessionRestController } from './web-session-rest.controller';

describe('WebSessionRestController（同源浏览器会话边界）', () => {
  const TRUSTED_ORIGIN = 'http://localhost:5173';

  const loginWithPasswordUsecase = { execute: jest.fn() } as unknown as LoginWithPasswordUsecase;
  const resolveWebSessionUsecase = { execute: jest.fn() } as unknown as ResolveWebSessionUsecase;
  const fetchUserInfoUsecase = {
    executeForLoginFlow: jest.fn(),
    executeStrict: jest.fn(),
  } as unknown as FetchUserInfoUsecase;

  const enabledOptions: WebSessionOptions = {
    enabled: true,
    cookieSecure: false,
    allowedOrigins: [TRUSTED_ORIGIN],
    issuer: 'ssts-local',
  };

  const buildController = (
    options: WebSessionOptions = enabledOptions,
    loginUsecase: LoginWithPasswordUsecase = loginWithPasswordUsecase,
  ) =>
    new WebSessionRestController(
      options,
      loginUsecase,
      resolveWebSessionUsecase,
      fetchUserInfoUsecase,
    );

  const request = (overrides: Partial<Request> = {}): Request =>
    ({
      headers: { origin: TRUSTED_ORIGIN },
      ip: '127.0.0.1',
      ...overrides,
    }) as unknown as Request;

  const response = (): Response & { setHeader: jest.Mock } =>
    ({ setHeader: jest.fn() }) as unknown as Response & { setHeader: jest.Mock };

  const captureError = async (promise: Promise<unknown>): Promise<HttpException> => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof HttpException) return error;
      throw error;
    }

    throw new Error('expected the call to reject');
  };

  const captureSyncError = (call: () => void): HttpException => {
    try {
      call();
    } catch (error) {
      if (error instanceof HttpException) return error;
      throw error;
    }

    throw new Error('expected the call to throw');
  };

  const userInfoView = {
    accountId: 42,
    nickname: '工程师甲',
    avatarUrl: null,
    accessGroup: [IdentityTypeEnum.ENGINEER],
  };

  const loginResult = {
    accessToken: 'access-token-from-usecase',
    refreshToken: 'refresh-token-must-not-leak',
    accountId: 42,
    role: IdentityTypeEnum.ENGINEER,
    restriction: SessionRestriction.NONE,
    adminLevel: null,
    customerOrganizationId: null,
    engineerOrganizationId: 7,
    adminOrganizationId: null,
    registrationOrganizationId: null,
    accessTokenExpiresAt: new Date(Date.now() + 60_000),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (loginWithPasswordUsecase.execute as jest.Mock).mockResolvedValue(loginResult);
    (fetchUserInfoUsecase.executeForLoginFlow as jest.Mock).mockResolvedValue({ userInfoView });
    (fetchUserInfoUsecase.executeStrict as jest.Mock).mockResolvedValue(userInfoView);
    (resolveWebSessionUsecase.execute as jest.Mock).mockResolvedValue({
      accessToken: 'cookie-token',
      session: {
        accountId: 42,
        role: IdentityTypeEnum.ENGINEER,
        restriction: SessionRestriction.NONE,
        adminLevel: null,
        customerOrganizationId: null,
        engineerOrganizationId: 7,
        adminOrganizationId: null,
        registrationOrganizationId: null,
      },
    });
  });

  describe('功能开关', () => {
    it('关闭时三个端点一律 404，且不触达任何用例', async () => {
      const controller = buildController({ ...enabledOptions, enabled: false });

      const errors = [
        await captureError(
          controller.login({ loginName: 'a', loginPassword: 'b' }, request(), response()),
        ),
        await captureError(controller.restore(request())),
        captureSyncError(() => controller.logout(request(), response())),
      ];

      for (const error of errors) {
        expect(error.getStatus()).toBe(404);
        expect(error.getResponse()).toMatchObject({ code: WEB_SESSION_REST_CODES.DISABLED });
      }

      expect(loginWithPasswordUsecase.execute).not.toHaveBeenCalled();
      expect(resolveWebSessionUsecase.execute).not.toHaveBeenCalled();
    });
  });

  describe('来源校验', () => {
    it('不可信来源返回 403，且在读取 Cookie / 调用用例之前拒绝', async () => {
      const controller = buildController();
      const untrusted = request({ headers: { origin: 'https://evil.example' } });

      const error = await captureError(controller.restore(untrusted));

      expect(error.getStatus()).toBe(403);
      expect(error.getResponse()).toMatchObject({
        code: WEB_SESSION_REST_CODES.ORIGIN_NOT_ALLOWED,
      });
      expect(resolveWebSessionUsecase.execute).not.toHaveBeenCalled();
    });

    it('缺少 Origin/Referer 时不通过 Host 兜底，直接 403', () => {
      const controller = buildController();

      const error = captureSyncError(() => controller.logout(request({ headers: {} }), response()));

      expect(error.getStatus()).toBe(403);
    });
  });

  describe('login', () => {
    it('复用登录用例并以网页受众/受限会话/服务端 IP 调用', async () => {
      const controller = buildController();
      const res = response();

      await controller.login(
        { loginName: '  engineer@example.com ', loginPassword: 'Secret#1' },
        request(),
        res,
      );

      expect(loginWithPasswordUsecase.execute).toHaveBeenCalledWith({
        loginName: 'engineer@example.com',
        loginPassword: 'Secret#1',
        type: LoginTypeEnum.PASSWORD,
        ip: '127.0.0.1',
        audience: AudienceTypeEnum.SSTSWEB,
        allowRestrictedSession: true,
      });
    });

    // 密码与登录名分离：登录名沿用 trim 规则，密码必须保留客户端提交的
    // 原始字符串（与原 GraphQL 登录入口一致），不得静默改写。
    it.each([
      ['前导空格', ' Secret#1'],
      ['尾随空格', 'Secret#1 '],
      ['首尾空格', '  Secret#1  '],
      ['制表符与换行', '\tSecret#1\n'],
    ])('密码（%s）按原始值原样传入登录用例，不做 trim', async (_label, rawPassword) => {
      await buildController().login(
        { loginName: 'a@example.com', loginPassword: rawPassword },
        request(),
        response(),
      );

      expect(loginWithPasswordUsecase.execute).toHaveBeenCalledWith(
        expect.objectContaining({ loginPassword: rawPassword }),
      );
    });

    it('只含空白的密码不是空值：原样传入登录用例（由真实密码校验拒绝）', async () => {
      await buildController().login(
        { loginName: 'a@example.com', loginPassword: '   ' },
        request(),
        response(),
      );

      expect(loginWithPasswordUsecase.execute).toHaveBeenCalledTimes(1);
      expect(loginWithPasswordUsecase.execute).toHaveBeenCalledWith(
        expect.objectContaining({ loginPassword: '   ' }),
      );
    });

    it.each([[undefined], [null], [123], [['Secret#1']], [{}]])(
      '密码为非字符串（%p）时返回 400，不调用登录用例',
      async (badPassword) => {
        const error = await captureError(
          buildController().login(
            { loginName: 'a@example.com', loginPassword: badPassword },
            request(),
            response(),
          ),
        );

        expect(error.getStatus()).toBe(400);
        expect(error.getResponse()).toMatchObject({ code: WEB_SESSION_REST_CODES.INVALID_INPUT });
        expect(loginWithPasswordUsecase.execute).not.toHaveBeenCalled();
      },
    );

    it('空字符串密码返回 400（密码不能为空），不调用登录用例', async () => {
      const error = await captureError(
        buildController().login(
          { loginName: 'a@example.com', loginPassword: '' },
          request(),
          response(),
        ),
      );

      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toMatchObject({ code: WEB_SESSION_REST_CODES.INVALID_INPUT });
      expect(loginWithPasswordUsecase.execute).not.toHaveBeenCalled();
    });

    it('密码超过长度上限返回 400；恰好等于上限的原值仍原样传入', async () => {
      const tooLong = 'a'.repeat(513);
      const error = await captureError(
        buildController().login(
          { loginName: 'a@example.com', loginPassword: ` ${tooLong} ` },
          request(),
          response(),
        ),
      );

      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toMatchObject({ code: WEB_SESSION_REST_CODES.INVALID_INPUT });
      expect(loginWithPasswordUsecase.execute).not.toHaveBeenCalled();

      const atLimit = ` ${'b'.repeat(510)} `;
      await buildController().login(
        { loginName: 'a@example.com', loginPassword: atLimit },
        request(),
        response(),
      );

      // 512 字符以内（含空白）通过校验，且按原始字符串（含空白）传入
      expect(loginWithPasswordUsecase.execute).toHaveBeenCalledWith(
        expect.objectContaining({ loginPassword: atLimit }),
      );
    });

    it('登录名超长仍按既有 trim 后限长规则返回 400（本轮零改动）', async () => {
      const error = await captureError(
        buildController().login(
          { loginName: ` ${'a'.repeat(513)} `, loginPassword: 'x' },
          request(),
          response(),
        ),
      );

      expect(error.getStatus()).toBe(400);
      expect(loginWithPasswordUsecase.execute).not.toHaveBeenCalled();
    });

    it('配置了网页有效期时才传 accessTokenTtl（未配置时保持全局时长语义）', async () => {
      await buildController({ ...enabledOptions, accessTokenTtl: '8h' }).login(
        { loginName: 'a@example.com', loginPassword: 'x' },
        request(),
        response(),
      );

      expect(loginWithPasswordUsecase.execute).toHaveBeenCalledWith(
        expect.objectContaining({ accessTokenTtl: '8h', audience: AudienceTypeEnum.SSTSWEB }),
      );

      jest.clearAllMocks();
      (loginWithPasswordUsecase.execute as jest.Mock).mockResolvedValue(loginResult);
      (fetchUserInfoUsecase.executeForLoginFlow as jest.Mock).mockResolvedValue({ userInfoView });

      await buildController().login(
        { loginName: 'a@example.com', loginPassword: 'x' },
        request(),
        response(),
      );

      expect(loginWithPasswordUsecase.execute).toHaveBeenCalledWith(
        expect.not.objectContaining({ accessTokenTtl: expect.anything() }),
      );
    });

    it('下发 HttpOnly/SameSite=Lax/窄路径 Cookie，Max-Age 不超过令牌剩余时间', async () => {
      const res = response();

      await buildController().login(
        { loginName: 'a@example.com', loginPassword: 'x' },
        request(),
        res,
      );

      const cookie = (res.setHeader as jest.Mock).mock.calls[0]?.[1] as string;

      expect(cookie).toContain(`${WEB_SESSION_COOKIE_NAME}=access-token-from-usecase`);
      expect(cookie).toContain(`Path=${WEB_SESSION_COOKIE_PATH}`);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).not.toContain('Domain=');

      const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
      expect(maxAge).toBeGreaterThan(0);
      expect(maxAge).toBeLessThanOrEqual(60);
    });

    it('响应体对齐前端会话装配字段，且不返回 refreshToken', async () => {
      const body = await buildController().login(
        { loginName: 'a@example.com', loginPassword: 'x' },
        request(),
        response(),
      );

      expect(body).toMatchObject({
        accessToken: 'access-token-from-usecase',
        accountId: 42,
        role: IdentityTypeEnum.ENGINEER,
        restriction: SessionRestriction.NONE,
        userInfo: { nickname: '工程师甲', accessGroup: [IdentityTypeEnum.ENGINEER] },
      });
      expect('refreshToken' in body).toBe(false);
    });

    it('无法确定令牌到期时不发 Cookie，并返回服务错误（不冒充未登录）', async () => {
      (loginWithPasswordUsecase.execute as jest.Mock).mockResolvedValue({
        ...loginResult,
        accessTokenExpiresAt: null,
      });
      const res = response();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const error = await captureError(
        buildController().login({ loginName: 'a@example.com', loginPassword: 'x' }, request(), res),
      );

      expect(error.getStatus()).toBe(500);
      expect(error.getResponse()).toMatchObject({
        code: WEB_SESSION_REST_CODES.PERSISTENCE_UNAVAILABLE,
      });
      expect(res.setHeader).not.toHaveBeenCalled();

      const loggedText = warn.mock.calls.flat().join(' ');
      expect(loggedText).not.toContain('access-token-from-usecase');
      expect(loggedText).not.toContain('Secret#1');
      warn.mockRestore();
    });

    it('凭据错误沿用既有领域码与 REST 状态映射（401），不透出密码', async () => {
      (loginWithPasswordUsecase.execute as jest.Mock).mockRejectedValue(
        new DomainError(AUTH_ERROR.INVALID_PASSWORD, '密码错误'),
      );

      const error = await captureError(
        buildController().login(
          { loginName: 'a@example.com', loginPassword: 'WrongPassword' },
          request(),
          response(),
        ),
      );

      expect(error.getStatus()).toBe(401);
      expect(error.getResponse()).toMatchObject({ code: AUTH_ERROR.INVALID_PASSWORD });
      expect(JSON.stringify(error.getResponse())).not.toContain('WrongPassword');
    });

    it('输入缺失或超长时返回 400，不调用登录用例', async () => {
      const error = await captureError(
        buildController().login({ loginName: '   ', loginPassword: 'x' }, request(), response()),
      );

      expect(error.getStatus()).toBe(400);
      expect(loginWithPasswordUsecase.execute).not.toHaveBeenCalled();
    });
  });

  /**
   * 真实认证链（非 mock 判定）：
   *
   * 控制器以真实 `LoginWithPasswordUsecase`（真实 `ResolveSessionRestrictionUsecase`
   * 与真实 `AccountService.verifyPassword` 哈希比对）装配，只替身签发/装配等
   * 与密码语义无关的下游。用于证明「密码按原始字符串校验」：正确密码前后多一个
   * 空格时，原始值确实进入认证用例并被真实密码校验链拒绝（401 INVALID_PASSWORD），
   * 不会因为入口 trim 被当成正确密码。
   */
  describe('login 密码原值语义（真实认证链）', () => {
    const CREATED_AT = new Date('2026-06-01T00:00:00Z');
    const REAL_PASSWORD = 'RealChain#Pass1';

    const buildRealChainController = (): WebSessionRestController => {
      const accountQueryService = {
        findCredentialByLoginName: jest.fn().mockResolvedValue({
          id: 42,
          status: AccountStatus.ACTIVE,
          loginEmail: 'real-chain@example.com',
          loginPassword: AccountService.hashPasswordWithTimestamp(REAL_PASSWORD, CREATED_AT),
          credentialVersion: 0,
          createdAt: CREATED_AT,
        }),
        findSessionAuthoritySnapshot: jest.fn().mockResolvedValue({
          accountId: 42,
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
        }),
      } as unknown as ConstructorParameters<typeof LoginWithPasswordUsecase>[0];
      const engineerRegistrationQueryService = {
        findLatestByAccountId: jest.fn().mockResolvedValue(null),
      } as unknown as ConstructorParameters<typeof ResolveSessionRestrictionUsecase>[0];
      const organizationMembershipQueryService = {
        listActiveMembershipsByAccount: jest.fn().mockResolvedValue([]),
      } as unknown as ConstructorParameters<typeof ResolveSessionRestrictionUsecase>[1];
      const executeLoginFlowUsecase = {
        execute: jest.fn().mockResolvedValue({
          tokens: { accessToken: 'basic-access', refreshToken: 'refresh-token' },
          credentialVersion: 0,
          accountId: 42,
          roleFromHint: IdentityTypeEnum.ENGINEER,
          accessGroup: [IdentityTypeEnum.ENGINEER],
          account: {
            id: 42,
            loginName: 'real-chain',
            loginEmail: 'real-chain@example.com',
            status: AccountStatus.ACTIVE,
            identityHint: IdentityTypeEnum.ENGINEER,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          },
          userInfo: {
            id: 1,
            accountId: 42,
            nickname: '真实链路工程师',
            avatarUrl: null,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          },
        }),
      } as unknown as ExecuteLoginFlowUsecase;
      const decideLoginRoleUsecase = {
        execute: jest.fn().mockReturnValue({
          finalRole: IdentityTypeEnum.ENGINEER,
          reason: 'hint',
        }),
      } as unknown as DecideLoginRoleUsecase;
      const tokenHelper = {
        generateAccessToken: jest.fn().mockReturnValue('signed-access-token'),
        decodeToken: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      } as unknown as TokenHelper;
      const enrichLoginWithIdentityUsecase = {
        execute: jest.fn().mockImplementation((input: { restriction?: SessionRestriction }) => ({
          accessToken: 'signed-access-token',
          refreshToken: 'refresh-token',
          accountId: 42,
          role: IdentityTypeEnum.ENGINEER,
          restriction: input.restriction,
        })),
      } as unknown as EnrichLoginWithIdentityUsecase;
      const logger = {
        setContext: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      } as unknown as PinoLogger;

      const realLoginUsecase = new LoginWithPasswordUsecase(
        accountQueryService,
        new ResolveSessionRestrictionUsecase(
          engineerRegistrationQueryService,
          organizationMembershipQueryService,
        ),
        executeLoginFlowUsecase,
        decideLoginRoleUsecase,
        enrichLoginWithIdentityUsecase,
        tokenHelper,
        logger,
      );

      return buildController(enabledOptions, realLoginUsecase);
    };

    it('正确密码通过真实认证链登录成功', async () => {
      const body = await buildRealChainController().login(
        { loginName: 'real-chain@example.com', loginPassword: REAL_PASSWORD },
        request(),
        response(),
      );

      expect(body).toMatchObject({
        accessToken: 'signed-access-token',
        accountId: 42,
        role: IdentityTypeEnum.ENGINEER,
      });
    });

    it.each([
      ['前导空格', ` ${REAL_PASSWORD}`],
      ['尾随空格', `${REAL_PASSWORD} `],
      ['首尾空格', `  ${REAL_PASSWORD}  `],
      ['只含空白', '   '],
    ])('密码（%s）原样进入真实密码校验链，不会被当成正确密码', async (_label, rawPassword) => {
      const error = await captureError(
        buildRealChainController().login(
          { loginName: 'real-chain@example.com', loginPassword: rawPassword },
          request(),
          response(),
        ),
      );

      expect(error.getStatus()).toBe(401);
      expect(error.getResponse()).toMatchObject({ code: AUTH_ERROR.INVALID_PASSWORD });
      expect(JSON.stringify(error.getResponse())).not.toContain(rawPassword);
    });
  });

  describe('restore', () => {
    it('没有 Cookie 时返回 401 ABSENT', async () => {
      const error = await captureError(
        buildController().restore(request({ headers: { origin: TRUSTED_ORIGIN } })),
      );

      expect(error.getStatus()).toBe(401);
      expect(error.getResponse()).toMatchObject({ code: WEB_SESSION_REST_CODES.ABSENT });
    });

    it('验签/受众失败返回 401 INVALID，且不写也不清 Cookie', async () => {
      (resolveWebSessionUsecase.execute as jest.Mock).mockRejectedValue(
        new DomainError(JWT_ERROR.TOKEN_INVALID, 'Token 无效'),
      );

      const error = await captureError(
        buildController().restore(
          request({
            headers: { origin: TRUSTED_ORIGIN, cookie: `${WEB_SESSION_COOKIE_NAME}=bad` },
          }),
        ),
      );

      expect(error.getStatus()).toBe(401);
      expect(error.getResponse()).toMatchObject({ code: WEB_SESSION_REST_CODES.INVALID });
    });

    it('会话复核失败（停用/凭据代次变化）返回 401 REVOKED，且不写 Cookie', async () => {
      (resolveWebSessionUsecase.execute as jest.Mock).mockRejectedValue(
        new DomainError(JWT_ERROR.AUTHENTICATION_FAILED, '认证失败'),
      );

      const error = await captureError(
        buildController().restore(
          request({
            headers: { origin: TRUSTED_ORIGIN, cookie: `${WEB_SESSION_COOKIE_NAME}=t` },
          }),
        ),
      );

      expect(error.getStatus()).toBe(401);
      expect(error.getResponse()).toMatchObject({ code: WEB_SESSION_REST_CODES.REVOKED });
    });

    it('数据库等非领域故障保持服务错误（不透传成 401）', async () => {
      const dbError = new Error('connection lost');
      (resolveWebSessionUsecase.execute as jest.Mock).mockRejectedValue(dbError);

      await expect(
        buildController().restore(
          request({
            headers: { origin: TRUSTED_ORIGIN, cookie: `${WEB_SESSION_COOKIE_NAME}=t` },
          }),
        ),
      ).rejects.toBe(dbError);
    });

    it('成功时返回同一个令牌与原会话事实，且不重签、不写 Cookie', async () => {
      const body = await buildController().restore(
        request({
          headers: {
            origin: TRUSTED_ORIGIN,
            cookie: `${WEB_SESSION_COOKIE_NAME}=cookie-token`,
          },
        }),
      );

      expect(body.accessToken).toBe('cookie-token');
      expect(body.accountId).toBe(42);
      expect(loginWithPasswordUsecase.execute).not.toHaveBeenCalled();
      // 恢复必须使用只读读取，不能触发登录流程的安全处置写入
      expect(fetchUserInfoUsecase.executeStrict).toHaveBeenCalledWith({ accountId: 42 });
      expect(fetchUserInfoUsecase.executeForLoginFlow).not.toHaveBeenCalled();
    });

    it('令牌缺少角色声明时按失效关闭（不猜角色）', async () => {
      (resolveWebSessionUsecase.execute as jest.Mock).mockResolvedValue({
        accessToken: 'cookie-token',
        session: {
          accountId: 42,
          role: null,
          restriction: SessionRestriction.NONE,
          adminLevel: null,
          customerOrganizationId: null,
          engineerOrganizationId: 7,
          adminOrganizationId: null,
          registrationOrganizationId: null,
        },
      });

      const error = await captureError(
        buildController().restore(
          request({
            headers: { origin: TRUSTED_ORIGIN, cookie: `${WEB_SESSION_COOKIE_NAME}=t` },
          }),
        ),
      );

      expect(error.getStatus()).toBe(401);
      expect(error.getResponse()).toMatchObject({ code: WEB_SESSION_REST_CODES.REVOKED });
    });

    it('受限会话（强制改密）仍然成功返回，由前端路由到受限页', async () => {
      (resolveWebSessionUsecase.execute as jest.Mock).mockResolvedValue({
        accessToken: 'cookie-token',
        session: {
          accountId: 42,
          role: IdentityTypeEnum.ENGINEER,
          restriction: SessionRestriction.MUST_CHANGE_PASSWORD,
          adminLevel: null,
          customerOrganizationId: null,
          engineerOrganizationId: 7,
          adminOrganizationId: null,
          registrationOrganizationId: null,
        },
      });

      const body = await buildController().restore(
        request({
          headers: { origin: TRUSTED_ORIGIN, cookie: `${WEB_SESSION_COOKIE_NAME}=t` },
        }),
      );

      expect(body.restriction).toBe(SessionRestriction.MUST_CHANGE_PASSWORD);
    });
  });

  describe('logout', () => {
    it('清除 Cookie（同名同路径 + Max-Age=0），无需有效令牌', () => {
      const res = response();

      buildController().logout(request({ headers: { origin: TRUSTED_ORIGIN } }), res);

      const cookie = (res.setHeader as jest.Mock).mock.calls[0]?.[1] as string;
      expect(cookie).toContain(`${WEB_SESSION_COOKIE_NAME}=;`);
      expect(cookie).toContain(`Path=${WEB_SESSION_COOKIE_PATH}`);
      expect(cookie).toContain('Max-Age=0');
      expect(resolveWebSessionUsecase.execute).not.toHaveBeenCalled();
    });

    it('启用 Secure 时清除 Cookie 同样带 Secure（否则浏览器不会覆盖）', () => {
      const res = response();

      buildController({ ...enabledOptions, cookieSecure: true }).logout(
        request({ headers: { origin: TRUSTED_ORIGIN } }),
        res,
      );

      expect((res.setHeader as jest.Mock).mock.calls[0]?.[1]).toContain('Secure');
    });
  });
});
