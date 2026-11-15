// src/modules/auth/queries/login-result.query.service.ts
import { BasicLoginResult, EnrichedLoginResult } from '@app-types/auth/login-flow.types';
import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { Injectable } from '@nestjs/common';
import { LoginUserDataCollection } from './login-bootstrap.query.service';

@Injectable()
export class LoginResultQueryService {
  toBasicLoginResult(params: {
    userData: LoginUserDataCollection;
    tokens: { accessToken: string; refreshToken: string };
  }): BasicLoginResult {
    const { userData, tokens } = params;
    const parsedIdentityHint = this.parseIdentityHint(userData.account.identityHint);
    return {
      tokens,
      accountId: userData.account.id,
      roleFromHint: parsedIdentityHint,
      accessGroup: userData.userWithAccessGroup.accessGroup,
      account: {
        id: userData.account.id,
        loginName: userData.account.loginName,
        loginEmail: userData.account.loginEmail,
        status: userData.account.status,
        identityHint: parsedIdentityHint,
        createdAt: userData.account.createdAt,
        updatedAt: userData.account.updatedAt,
      },
      userInfo: {
        id: userData.userInfo.id,
        accountId: userData.userInfo.accountId,
        nickname: userData.userInfo.nickname,
        avatarUrl: userData.userInfo.avatarUrl,
        createdAt: userData.userInfo.createdAt,
        updatedAt: userData.userInfo.updatedAt,
      },
    };
  }

  toEnrichedLoginResult(params: {
    tokens: { accessToken: string; refreshToken: string };
    accountId: number;
    finalRole: IdentityTypeEnum;
    accessGroup: IdentityTypeEnum[];
    account: {
      id: number;
      loginName: string | null;
      loginEmail: string | null;
      status: AccountStatus;
      identityHint: IdentityTypeEnum | null;
      createdAt: Date;
      updatedAt: Date;
    };
    userInfo: {
      id: number;
      accountId: number;
      nickname: string;
      avatarUrl: string | null;
      createdAt: Date;
      updatedAt: Date;
    };
    identity: unknown;
    warnings: string[];
    includeAccount: boolean;
    includeUserInfo: boolean;
    restriction?: SessionRestriction;
    adminLevel?: number | null;
    customerOrganizationId?: number | null;
    engineerOrganizationId?: number | null;
    adminOrganizationId?: number | null;
    registrationOrganizationId?: number | null;
  }): EnrichedLoginResult {
    const {
      tokens,
      accountId,
      finalRole,
      accessGroup,
      account,
      userInfo,
      identity,
      warnings,
      includeAccount,
      includeUserInfo,
      restriction = SessionRestriction.NONE,
      adminLevel = null,
      customerOrganizationId = null,
      engineerOrganizationId = null,
      adminOrganizationId = null,
      registrationOrganizationId = null,
    } = params;
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accountId,
      role: finalRole,
      identity,
      accessGroup,
      restriction,
      adminLevel,
      customerOrganizationId,
      engineerOrganizationId,
      adminOrganizationId,
      registrationOrganizationId,
      ...(includeAccount && { account }),
      ...(includeUserInfo && { userInfo }),
      ...(warnings.length > 0 && { warnings }),
    };
  }

  private parseIdentityHint(identityHint: string | null): IdentityTypeEnum | null {
    if (!identityHint) {
      return null;
    }
    const enumValues = Object.values(IdentityTypeEnum) as string[];
    if (enumValues.includes(identityHint)) {
      return identityHint as IdentityTypeEnum;
    }
    return null;
  }
}
