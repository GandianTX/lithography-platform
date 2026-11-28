// src/usecases/auth/login-with-password.usecase.ts

import { EnrichedLoginResult, LoginWarningType } from '@app-types/auth/login-flow.types';
import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import { JwtPayload } from '@app-types/jwt.types';
import { AuthLoginModel } from '@app-types/models/auth.types';
import { evaluateSessionStatusCombination } from '@core/account/policy/session-restriction.policy';
import { AUTH_ERROR, DomainError, isDomainError } from '@core/common/errors';
import { Injectable } from '@nestjs/common';
import { TokenHelper } from '@modules/auth/token.helper';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { PinoLogger } from 'nestjs-pino';
import { DecideLoginRoleUsecase } from './decide-login-role.usecase';
import { EnrichLoginWithIdentityUsecase } from './enrich-login-with-identity.usecase';
import { ExecuteLoginFlowUsecase } from './execute-login-flow.usecase';
import { ResolveSessionRestrictionUsecase } from './resolve-session-restriction.usecase';

/**
 * 密码登录用例
 * 负责编排密码登录的完整流程（Validate → Execute → Decide → Enrich）
 */
@Injectable()
export class LoginWithPasswordUsecase {
  constructor(
    private readonly accountQueryService: AccountQueryService,
    private readonly resolveSessionRestrictionUsecase: ResolveSessionRestrictionUsecase,
    private readonly executeLoginFlowUsecase: ExecuteLoginFlowUsecase,
    private readonly decideLoginRoleUsecase: DecideLoginRoleUsecase,
    private readonly enrichLoginWithIdentityUsecase: EnrichLoginWithIdentityUsecase,
    private readonly tokenHelper: TokenHelper,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(LoginWithPasswordUsecase.name);
  }

  /**
   * 执行密码登录（四段式编排）
   * @param params 登录参数
   * @returns 增强的登录结果
   */
  async execute({
    loginName,
    loginPassword,
    ip,
    audience,
    allowRestrictedSession,
    accessTokenTtl,
  }: AuthLoginModel): Promise<EnrichedLoginResult> {
    try {
      // Validate: 验证登录凭据（同时计算会话限制状态）
      const loginContext = await this.validateLoginCredentials({
        loginName,
        loginPassword,
        allowRestrictedSession,
      });
      const account = loginContext.account;
      // 固定真正通过密码验证的快照代次，后续读取不得把旧密码提升为新代次会话。
      const verifiedCredentialVersion = account.credentialVersion;

      // Execute: 执行基础登录流程（受限会话允许 PENDING 账号继续签发令牌）
      const basicResult = await this.executeLoginFlowUsecase.execute({
        accountId: account.id,
        ip,
        audience,
        allowPendingAccount: loginContext.allowPendingAccount,
      });

      // 若密码验证之后发生改密 / 补发 / 重置或公司状态变更，本次登录必须失败关闭。
      if (basicResult.credentialVersion !== verifiedCredentialVersion) {
        throw new DomainError(AUTH_ERROR.INVALID_PASSWORD, '密码错误');
      }

      // Decide: 决策最终角色
      const { finalRole, reason } = this.decideLoginRoleUsecase.execute(
        { roleFromHint: basicResult.roleFromHint, accessGroup: basicResult.accessGroup },
        {
          accountId: basicResult.accountId,
          ip: ip || '',
          userAgent: '',
          audience: audience,
        },
      );

      const hasRoles = Array.isArray(basicResult.accessGroup) && basicResult.accessGroup.length > 0;
      if (hasRoles && !basicResult.accessGroup.includes(finalRole)) {
        this.logger.warn(
          {
            accountId: basicResult.accountId,
            loginName,
            finalRole,
            accessGroup: basicResult.accessGroup,
            event: 'login_permission_mismatch',
          },
          '登录失败：角色与权限组不匹配',
        );
        throw new DomainError(AUTH_ERROR.PERMISSION_MISMATCH, '权限信息异常，拒绝登录', {
          finalRole,
          accessGroup: basicResult.accessGroup,
        });
      }

      const payload: JwtPayload = {
        sub: basicResult.accountId,
        username: basicResult.userInfo.nickname,
        email: basicResult.account.loginEmail,
        accessGroup: basicResult.accessGroup,
        credentialVersion: verifiedCredentialVersion,
        ...(hasRoles ? { activeRole: finalRole } : {}),
      };
      // 只有显式传入 `accessTokenTtl` 的入口（浏览器会话 REST 登录）会覆盖本次令牌有效期；
      // 其余调用方不传，签发继续沿用 `JwtModule` 的全局 `JWT_EXPIRES_IN`，
      // Refresh Token 仍由 `ExecuteLoginFlowUsecase` 按全局配置签发，不受此处影响。
      const accessToken = this.tokenHelper.generateAccessToken({
        payload,
        audience,
        ...(accessTokenTtl ? { expiresIn: accessTokenTtl } : {}),
      });
      const accessTokenExpiresAt = this.resolveAccessTokenExpiresAt(accessToken);
      const tokens = { accessToken, refreshToken: basicResult.tokens.refreshToken };

      // Enrich: 装配身份信息
      const enrichedResult = await this.enrichLoginWithIdentityUsecase.execute({
        tokens,
        accountId: basicResult.accountId,
        finalRole,
        accessGroup: basicResult.accessGroup,
        account: basicResult.account,
        userInfo: basicResult.userInfo,
        restriction: loginContext.restriction,
        adminLevel: loginContext.adminLevel,
        customerOrganizationId: loginContext.customerOrganizationId,
        engineerOrganizationId: loginContext.engineerOrganizationId,
        adminOrganizationId: loginContext.adminOrganizationId,
        registrationOrganizationId: loginContext.registrationOrganizationId,
        options: { includeIdentity: true },
      });

      // 如果角色决策使用了 fallback 策略，添加警告信息
      if (reason === 'fallback') {
        enrichedResult.warnings = [
          ...(enrichedResult.warnings ?? []),
          LoginWarningType.ROLE_FALLBACK,
        ];
      }

      // 把签发结果的到期事实交给适配器（浏览器 Cookie 的 Max-Age 必须不晚于令牌过期）。
      // 这里只读令牌自身的 `exp`，不参与任何授权判定，也不改变其他调用方行为。
      enrichedResult.accessTokenExpiresAt = accessTokenExpiresAt;

      return enrichedResult;
    } catch (error) {
      // 记录登录失败
      this.logger.error(
        { loginName, ip, audience, error: isDomainError(error) ? error.code : 'UNKNOWN_ERROR' },
        '密码登录失败',
      );

      // 直接重新抛出错误，让上层适配器处理
      throw error;
    }
  }

  /**
   * 解析刚签发令牌的到期时刻。
   *
   * 只解码（不验签、不写日志、不记录令牌片段）：签发方刚生成的令牌必然可信；
   * 解码失败返回 `null`，由调用方失败关闭（例如不下发浏览器 Cookie），
   * 绝不以配置值猜测有效期。
   */
  private resolveAccessTokenExpiresAt(accessToken: string): Date | null {
    const payload = this.tokenHelper.decodeToken({ token: accessToken });

    if (!payload || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      return null;
    }

    return new Date(payload.exp * 1000);
  }

  /**
   * 验证登录凭据，并计算会话限制状态。
   *
   * 放行条件（与 `ValidateAccessTokenSessionUsecase` 的每请求复核口径一致）：
   * - 账号 `ACTIVE` 且资料 `ACTIVE`、无限制 → 正常会话；
   * - 账号 `/` 资料为 `PENDING` 且存在明确限制（必须改密 / 工程师待审 / 工程师拒绝），
   *   并且调用方显式传入 `allowRestrictedSession: true` → 受限会话；
   * - 其余状态（封禁、删除、暂停、长期不活跃等）即使存在限制也一律拒绝——
   *   否则会签发一个「能登录但每个请求都被复核拒绝」的无效令牌；
   * - 其余情况维持既有 `ACCOUNT_INACTIVE` 失败口径。
   *
   * @param params 登录名、密码与受限会话开关
   * @returns 凭据快照 + 限制状态 + 身份扩展字段
   */
  private async validateLoginCredentials({
    loginName,
    loginPassword,
    allowRestrictedSession,
  }: Pick<AuthLoginModel, 'loginName' | 'loginPassword' | 'allowRestrictedSession'>) {
    // 查找账户（支持登录名或邮箱）
    const account = await this.accountQueryService.findCredentialByLoginName({ loginName });
    if (!account) {
      throw new DomainError(AUTH_ERROR.ACCOUNT_NOT_FOUND, '账户不存在');
    }

    // 读取当前授权事实并计算限制状态（不改写任何数据库字段）。申请、成员与组织事实
    // 由统一用例读取，保证登录签发与每请求复核口径一致。
    const snapshot = await this.accountQueryService.findSessionAuthoritySnapshot({
      accountId: account.id,
    });
    const resolution = await this.resolveSessionRestrictionUsecase.execute({
      accountId: account.id,
      snapshot,
    });
    const restriction = resolution.restriction;

    const isRestrictedSessionAllowed =
      allowRestrictedSession === true && restriction !== SessionRestriction.NONE;

    // 状态放行与每请求复核同源（共用 core 纯策略）：仅 `ACTIVE` / `ACTIVE` 正常放行、
    // `PENDING` / `PENDING` 在「存在明确限制 + 显式允许受限会话」时放行；单边状态不一致、
    // 缺行，以及封禁 / 删除 / 暂停 / 长期不活跃一律在这里失败关闭，不再签发随后必被复核
    // 拒绝的令牌。
    const statusDecision = evaluateSessionStatusCombination({
      restriction,
      allowRestrictedSession: allowRestrictedSession === true,
      accountStatus: snapshot.accountStatus,
      userState: snapshot.userInfo?.userState ?? null,
    });

    if (!statusDecision.allowed) {
      throw new DomainError(AUTH_ERROR.ACCOUNT_INACTIVE, '账户未激活或已被禁用');
    }

    // 验证密码
    const isPasswordValid = AccountService.verifyPassword(
      loginPassword,
      account.loginPassword,
      account.createdAt,
    );

    if (!isPasswordValid) {
      throw new DomainError(AUTH_ERROR.INVALID_PASSWORD, '密码错误');
    }

    // 授权读取期间若凭据已更换，刚验证的旧哈希不能借新授权快照继续登录。
    // 使用既有凭据错误，避免向调用方暴露代次或重置事实。
    if (snapshot.credentialVersion !== account.credentialVersion) {
      throw new DomainError(AUTH_ERROR.INVALID_PASSWORD, '密码错误');
    }

    return {
      account,
      restriction,
      allowPendingAccount: isRestrictedSessionAllowed,
      adminLevel: snapshot.adminLevel,
      customerOrganizationId: snapshot.userInfo?.customerOrganizationId ?? null,
      engineerOrganizationId: resolution.engineerOrganizationId,
      adminOrganizationId: resolution.adminOrganizationId,
      registrationOrganizationId: resolution.latestEngineerApplication?.organizationId ?? null,
    };
  }
}
