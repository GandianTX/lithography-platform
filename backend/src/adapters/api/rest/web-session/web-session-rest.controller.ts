// src/adapters/api/rest/web-session/web-session-rest.controller.ts

import {
  SessionRestriction,
  type AuthenticatedSessionUser,
} from '@app-types/auth/session-restriction.types';
import { AudienceTypeEnum, IdentityTypeEnum, LoginTypeEnum } from '@app-types/models/account.types';
import type { UserInfoView } from '@app-types/models/auth.types';
import { DomainError, JWT_ERROR } from '@core/common/errors/domain-error';
import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { FetchUserInfoUsecase } from '@usecases/account/fetch-user-info.usecase';
import { LoginWithPasswordUsecase } from '@usecases/auth/login-with-password.usecase';
import { ResolveWebSessionUsecase } from '@usecases/auth/resolve-web-session.usecase';
import type { Request, Response } from 'express';

import { toRestError } from '../shared/upload-boundary.util';
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  computeCookieMaxAgeSeconds,
  isTrustedRequestOrigin,
  readCookieValue,
} from './web-session-cookie';
import {
  WEB_SESSION_COOKIE_NAME,
  WEB_SESSION_OPTIONS,
  WEB_SESSION_REST_CODES,
  type WebSessionOptions,
} from './web-session.options';

/**
 * 浏览器会话响应的用户摘要。
 *
 * 与 GraphQL `UserInfoDTO` 的字段子集逐字对齐（nickname / accessGroup / avatarUrl），
 * 直接喂给前端既有的 `decodeAuthSessionPayload`，不新增第二套身份装配规则。
 */
export interface WebSessionUserInfoBody {
  readonly nickname: string;
  readonly accessGroup: IdentityTypeEnum[];
  readonly avatarUrl: string | null;
}

/** 登录与恢复返回同一形状；前端复用同一解码器。 */
export interface WebSessionResponseBody {
  readonly accessToken: string;
  readonly accountId: number;
  readonly role: IdentityTypeEnum;
  readonly restriction: SessionRestriction;
  readonly adminLevel: number | null;
  readonly customerOrganizationId: number | null;
  readonly engineerOrganizationId: number | null;
  readonly adminOrganizationId: number | null;
  readonly registrationOrganizationId: number | null;
  readonly userInfo: WebSessionUserInfoBody | null;
}

const MAX_LOGIN_NAME_LENGTH = 512;
const MAX_LOGIN_PASSWORD_LENGTH = 512;

interface WebSessionLoginBody {
  loginName?: unknown;
  loginPassword?: unknown;
}

/**
 * 浏览器会话 REST 边界（同源）。
 *
 * 设计约束（实现时不得放宽）：
 * - 只负责「网页登录 / 恢复 / 退出」三件事，业务 GraphQL、REST、上传下载仍只认 Bearer；
 * - 账号密码校验、失败处理、身份/角色/组织与强制改密规则全部复用既有 usecase，
 *   本控制器不做任何认证判定；
 * - 恢复不重签、不延长、不写登录历史，也不写/清 Cookie（写由登录、清除由退出）；
 * - 不记录密码、Authorization、Cookie、Set-Cookie、令牌片段或带凭据的响应体。
 */
@Controller('api/auth/web-session')
export class WebSessionRestController {
  private readonly logger = new Logger(WebSessionRestController.name);

  constructor(
    @Inject(WEB_SESSION_OPTIONS) private readonly options: WebSessionOptions,
    private readonly loginWithPasswordUsecase: LoginWithPasswordUsecase,
    private readonly resolveWebSessionUsecase: ResolveWebSessionUsecase,
    private readonly fetchUserInfoUsecase: FetchUserInfoUsecase,
  ) {}

  /**
   * 网页登录：复用 GraphQL 登录完全相同的用例与限制规则。
   *
   * 唯一差异是 `accessTokenTtl`（可选）与 `audience=SSTSWEB`；前者未配置时不传，
   * 签发继续走全局 `JWT_EXPIRES_IN`。
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  async login(
    @Body() body: WebSessionLoginBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WebSessionResponseBody> {
    this.assertEnabled();
    this.assertTrustedOrigin(request);

    const loginName = this.readRequiredCredential(
      body?.loginName,
      'loginName',
      MAX_LOGIN_NAME_LENGTH,
    );
    const loginPassword = this.readRequiredCredential(
      body?.loginPassword,
      'loginPassword',
      MAX_LOGIN_PASSWORD_LENGTH,
    );

    let result: Awaited<ReturnType<LoginWithPasswordUsecase['execute']>>;

    try {
      result = await this.loginWithPasswordUsecase.execute({
        loginName,
        loginPassword,
        type: LoginTypeEnum.PASSWORD,
        ...(request.ip ? { ip: request.ip } : {}),
        audience: AudienceTypeEnum.SSTSWEB,
        allowRestrictedSession: true,
        ...(this.options.accessTokenTtl ? { accessTokenTtl: this.options.accessTokenTtl } : {}),
      });
    } catch (error) {
      return this.throwLoginError(error);
    }

    const userInfoView = await this.loadUserInfoForLogin(result.accountId);

    const maxAgeSeconds = computeCookieMaxAgeSeconds({
      expiresAt: result.accessTokenExpiresAt,
      now: new Date(),
    });

    // Cookie 必须不晚于令牌过期：拿不到到期事实时失败关闭，不用配置值猜测窗口。
    // 这不是「未登录」，所以返回服务错误而不是 401。
    if (maxAgeSeconds <= 0) {
      this.logger.warn(
        `浏览器会话 Cookie 无法确定安全有效期，已拒绝下发（accountId=${result.accountId}）`,
      );
      throw this.webSessionError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        WEB_SESSION_REST_CODES.PERSISTENCE_UNAVAILABLE,
        '浏览器会话暂时不可用，请稍后重试',
      );
    }

    response.setHeader(
      'Set-Cookie',
      buildSessionCookie({
        token: result.accessToken,
        maxAgeSeconds,
        secure: this.options.cookieSecure,
      }),
    );

    return {
      accessToken: result.accessToken,
      accountId: result.accountId,
      role: result.role,
      restriction: result.restriction ?? SessionRestriction.NONE,
      adminLevel: result.adminLevel ?? null,
      customerOrganizationId: result.customerOrganizationId ?? null,
      engineerOrganizationId: result.engineerOrganizationId ?? null,
      adminOrganizationId: result.adminOrganizationId ?? null,
      registrationOrganizationId: result.registrationOrganizationId ?? null,
      userInfo: this.toUserInfoBody(userInfoView),
    };
  }

  /**
   * 会话恢复：只读。
   *
   * 令牌来源只有 Cookie；验签 + 签发者 + **受众必须是网页受众** + 有效期，
   * 随后交给 `ResolveWebSessionUsecase` 复用每请求会话复核（账号状态、角色集、
   * 凭据代次、受限状态等）。返回原令牌与原到期，不重签、不延长、不写登录历史，
   * 也**不写也不清 Cookie**（避免迟到响应覆盖更新的会话）。
   */
  @Post('restore')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  async restore(@Req() request: Request): Promise<WebSessionResponseBody> {
    this.assertEnabled();
    this.assertTrustedOrigin(request);

    const token = readCookieValue(request.headers.cookie, WEB_SESSION_COOKIE_NAME);

    if (!token) {
      throw this.webSessionError(
        HttpStatus.UNAUTHORIZED,
        WEB_SESSION_REST_CODES.ABSENT,
        '没有可恢复的浏览器会话',
      );
    }

    let resolved: Awaited<ReturnType<ResolveWebSessionUsecase['execute']>>;

    try {
      resolved = await this.resolveWebSessionUsecase.execute({
        token,
        ...(this.options.issuer ? { issuer: this.options.issuer } : {}),
      });
    } catch (error) {
      return this.throwRestoreError(error);
    }

    const session = resolved.session;
    const role = this.resolveTrustedRole(session);
    const userInfoView = await this.loadUserInfoForSession(session.accountId);

    return {
      accessToken: resolved.accessToken,
      accountId: session.accountId,
      role,
      restriction: session.restriction ?? SessionRestriction.NONE,
      adminLevel: session.adminLevel ?? null,
      customerOrganizationId: session.customerOrganizationId ?? null,
      engineerOrganizationId: session.engineerOrganizationId ?? null,
      adminOrganizationId: session.adminOrganizationId ?? null,
      registrationOrganizationId: session.registrationOrganizationId ?? null,
      userInfo: this.toUserInfoBody(userInfoView),
    };
  }

  /**
   * 主动退出：只清 Cookie。
   *
   * 不依赖有效令牌（令牌已过期也必须能退出），也不查库；幂等，无 Cookie 同样 204。
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): void {
    this.assertEnabled();
    this.assertTrustedOrigin(request);

    response.setHeader(
      'Set-Cookie',
      buildClearedSessionCookie({ secure: this.options.cookieSecure }),
    );
  }

  private assertEnabled(): void {
    if (!this.options.enabled) {
      // 关闭时行为与改造前完全一致：路径不存在，不暴露任何会话语义
      throw this.webSessionError(
        HttpStatus.NOT_FOUND,
        WEB_SESSION_REST_CODES.DISABLED,
        '浏览器会话未启用',
      );
    }
  }

  private assertTrustedOrigin(request: Request): void {
    const trusted = isTrustedRequestOrigin({
      origin: typeof request.headers.origin === 'string' ? request.headers.origin : undefined,
      referer: typeof request.headers.referer === 'string' ? request.headers.referer : undefined,
      allowedOrigins: this.options.allowedOrigins,
    });

    if (!trusted) {
      throw this.webSessionError(
        HttpStatus.FORBIDDEN,
        WEB_SESSION_REST_CODES.ORIGIN_NOT_ALLOWED,
        '请求来源不可信',
      );
    }
  }

  private readRequiredCredential(
    value: unknown,
    field: 'loginName' | 'loginPassword',
    maxLength: number,
  ): string {
    if (typeof value !== 'string') {
      throw this.webSessionError(
        HttpStatus.BAD_REQUEST,
        WEB_SESSION_REST_CODES.INVALID_INPUT,
        '登录参数不完整',
      );
    }

    const trimmed = value.trim();

    if (!trimmed || trimmed.length > maxLength) {
      throw this.webSessionError(
        HttpStatus.BAD_REQUEST,
        WEB_SESSION_REST_CODES.INVALID_INPUT,
        field === 'loginName' ? '登录名不能为空' : '密码不能为空',
      );
    }

    return trimmed;
  }

  /** 登录失败沿用既有领域错误码与 REST 状态映射（AUTH_ERROR/JWT_ERROR → 401）。 */
  private throwLoginError(error: unknown): never {
    if (error instanceof DomainError) {
      return toRestError(error);
    }

    throw error;
  }

  /**
   * 恢复失败的错误映射。
   *
   * - 验签/受众/有效期不通过 → `WEB_SESSION_INVALID`（401）
   * - 会话复核不通过（停用、凭据代次、角色集变化等）→ `WEB_SESSION_REVOKED`（401）
   * - 其余（数据库不可用等）保持原样上抛 → 服务错误，不冒充未登录
   */
  private throwRestoreError(error: unknown): never {
    if (error instanceof DomainError) {
      const invalid =
        error.code === JWT_ERROR.TOKEN_EXPIRED || error.code === JWT_ERROR.TOKEN_INVALID;

      throw this.webSessionError(
        HttpStatus.UNAUTHORIZED,
        invalid ? WEB_SESSION_REST_CODES.INVALID : WEB_SESSION_REST_CODES.REVOKED,
        invalid ? '浏览器会话已过期或无效' : '浏览器会话已失效，请重新登录',
      );
    }

    throw error;
  }

  /**
   * 恢复会话的角色必须可由令牌自身声明确定。
   *
   * 网页登录总是写入 `activeRole`；缺失说明是旧版/非网页令牌，无法安全装配前端会话，
   * 按失效关闭，不猜角色、不新增角色推导规则。
   */
  private resolveTrustedRole(session: AuthenticatedSessionUser): IdentityTypeEnum {
    if (!session.role) {
      throw this.webSessionError(
        HttpStatus.UNAUTHORIZED,
        WEB_SESSION_REST_CODES.REVOKED,
        '浏览器会话缺少可用的角色声明',
      );
    }

    return session.role;
  }

  private async loadUserInfoForLogin(accountId: number): Promise<UserInfoView> {
    try {
      const completeUserData = await this.fetchUserInfoUsecase.executeForLoginFlow({ accountId });

      return completeUserData.userInfoView;
    } catch (error) {
      if (error instanceof DomainError) {
        return toRestError(error);
      }

      throw error;
    }
  }

  /** 恢复路径只用只读读取，绝不触发登录流程里的安全处置写入。 */
  private async loadUserInfoForSession(accountId: number): Promise<UserInfoView> {
    return await this.fetchUserInfoUsecase.executeStrict({ accountId });
  }

  private toUserInfoBody(userInfoView: UserInfoView): WebSessionUserInfoBody | null {
    const accessGroup = Array.isArray(userInfoView?.accessGroup) ? userInfoView.accessGroup : [];

    if (typeof userInfoView?.nickname !== 'string' || accessGroup.length === 0) {
      return null;
    }

    return {
      nickname: userInfoView.nickname,
      accessGroup,
      avatarUrl: userInfoView.avatarUrl ?? null,
    };
  }

  private webSessionError(status: number, code: string, message: string): HttpException {
    return new HttpException({ statusCode: status, code, message }, status);
  }
}
