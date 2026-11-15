// src/usecases/auth/login-by-account-id.usecase.ts

import { EnrichedLoginResult, LoginWarningType } from '@app-types/auth/login-flow.types';
import { JwtPayload } from '@app-types/jwt.types';
import { AudienceTypeEnum, ThirdPartyProviderEnum } from '@app-types/models/account.types';
import { AUTH_ERROR, DomainError } from '@core/common/errors';
import { TokenHelper } from '@modules/auth/token.helper';
import { Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { DecideLoginRoleUsecase } from './decide-login-role.usecase';
import { EnrichLoginWithIdentityUsecase } from './enrich-login-with-identity.usecase';
import { ExecuteLoginFlowUsecase } from './execute-login-flow.usecase';
import { ResolveSessionRestrictionUsecase } from './resolve-session-restriction.usecase';

/**
 * 根据账户 ID 登录用例（三段式编排）
 * 用于内部系统或已验证的场景（如第三方登录）
 */
@Injectable()
export class LoginByAccountIdUsecase {
  constructor(
    private readonly accountQueryService: AccountQueryService,
    private readonly resolveSessionRestrictionUsecase: ResolveSessionRestrictionUsecase,
    private readonly executeLoginFlowUsecase: ExecuteLoginFlowUsecase,
    private readonly decideLoginRoleUsecase: DecideLoginRoleUsecase,
    private readonly enrichLoginWithIdentityUsecase: EnrichLoginWithIdentityUsecase,
    private readonly tokenHelper: TokenHelper,
  ) {}

  /**
   * 根据账户 ID 执行登录（三段式编排）
   * @param params 登录参数
   * @param params.accountId 账户 ID
   * @param params.ip 客户端 IP 地址
   * @param params.audience 客户端类型
   * @param params.provider 第三方登录提供商（可选，用于区分第三方登录）
   * @returns 增强的登录结果
   */
  /**
   * 根据账户 ID 执行登录（三段式编排）
   * 1) 执行基础登录流程（获取账户与用户信息、校验状态）
   * 2) 决策最终角色（基于 roleFromHint 与 accessGroup）
   * 3) 在角色决策之后重签发 Access Token，写入 activeRole
   * 4) 装配身份信息并返回增强结果
   */
  async execute({
    accountId,
    ip,
    audience,
    provider,
  }: {
    accountId: number;
    ip?: string;
    audience?: AudienceTypeEnum;
    provider?: ThirdPartyProviderEnum;
  }): Promise<EnrichedLoginResult> {
    // Execute: 执行基础登录流程
    const basicResult = await this.executeLoginFlowUsecase.execute({
      accountId,
      ip,
      audience,
      provider,
    });

    // Decide: 决策最终角色
    const { finalRole, reason } = this.decideLoginRoleUsecase.execute(
      { roleFromHint: basicResult.roleFromHint, accessGroup: basicResult.accessGroup },
      {
        accountId: basicResult.accountId,
        ip: ip || '',
        userAgent: '-',
        audience: audience || AudienceTypeEnum.DESKTOP,
      },
    );

    const hasRoles = Array.isArray(basicResult.accessGroup) && basicResult.accessGroup.length > 0;
    if (hasRoles && !basicResult.accessGroup.includes(finalRole)) {
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
      ...(hasRoles ? { activeRole: finalRole } : {}),
    };
    const accessToken = this.tokenHelper.generateAccessToken({ payload, audience });
    const tokens = { accessToken, refreshToken: basicResult.tokens.refreshToken };

    // Resolve: 按数据库事实计算会话限制与可信组织身份。
    // 与 `LoginWithPasswordUsecase` / `ValidateAccessTokenSessionUsecase` 共用同一读取入口，
    // 保证第三方签发返回的 `restriction` 与随后每请求复核、`mySessionIdentity` 口径一致。
    const snapshot = await this.accountQueryService.findSessionAuthoritySnapshot({
      accountId: basicResult.accountId,
    });
    const resolution = await this.resolveSessionRestrictionUsecase.execute({
      accountId: basicResult.accountId,
      snapshot,
    });

    // Enrich: 装配身份信息
    const enrichedResult = await this.enrichLoginWithIdentityUsecase.execute({
      tokens,
      accountId: basicResult.accountId,
      finalRole,
      accessGroup: basicResult.accessGroup,
      account: basicResult.account,
      userInfo: basicResult.userInfo,
      restriction: resolution.restriction,
      adminLevel: snapshot.adminLevel,
      customerOrganizationId: snapshot.userInfo?.customerOrganizationId ?? null,
      engineerOrganizationId: resolution.engineerOrganizationId,
      adminOrganizationId: resolution.adminOrganizationId,
      registrationOrganizationId: resolution.latestEngineerApplication?.organizationId ?? null,
      options: { includeIdentity: true },
    });

    // 如果角色决策使用了 fallback 策略，添加警告信息
    if (reason === 'fallback') {
      enrichedResult.warnings = [
        ...(enrichedResult.warnings ?? []),
        LoginWarningType.ROLE_FALLBACK,
      ];
    }

    return enrichedResult;
  }
}
