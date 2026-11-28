// src/adapters/api/rest/web-session/web-session-rest.controller.spec.ts

import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import { AudienceTypeEnum, IdentityTypeEnum, LoginTypeEnum } from '@app-types/models/account.types';
import { DomainError, AUTH_ERROR, JWT_ERROR } from '@core/common/errors/domain-error';
import { HttpException, Logger } from '@nestjs/common';
import { FetchUserInfoUsecase } from '@usecases/account/fetch-user-info.usecase';
import { LoginWithPasswordUsecase } from '@usecases/auth/login-with-password.usecase';
import { ResolveWebSessionUsecase } from '@usecases/auth/resolve-web-session.usecase';
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

  const buildController = (options: WebSessionOptions = enabledOptions) =>
    new WebSessionRestController(
      options,
      loginWithPasswordUsecase,
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
