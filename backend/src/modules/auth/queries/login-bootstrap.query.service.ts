// src/modules/auth/queries/login-bootstrap.query.service.ts
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { Injectable } from '@nestjs/common';

export interface LoginUserDataCollection {
  userWithAccessGroup: {
    id: number;
    loginEmail: string | null;
    accessGroup: IdentityTypeEnum[];
  };
  account: {
    id: number;
    loginName: string | null;
    loginEmail: string | null;
    status: AccountStatus;
    identityHint: string | null;
    createdAt: Date;
    updatedAt: Date;
    credentialVersion: number;
  };
  userInfo: {
    id: number;
    accountId: number;
    nickname: string;
    avatarUrl: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
}

@Injectable()
export class LoginBootstrapQueryService {
  toLoginUserDataCollection(params: {
    account: {
      id: number;
      loginName: string | null;
      loginEmail: string | null;
      status: AccountStatus;
      identityHint: string | null;
      createdAt: Date;
      updatedAt: Date;
      credentialVersion: number;
    };
    userInfo: {
      id: number;
      accountId: number;
      nickname: string | null;
      avatarUrl: string | null;
      createdAt: Date;
      updatedAt: Date;
      accessGroup?: IdentityTypeEnum[] | null;
    };
  }): LoginUserDataCollection {
    return {
      userWithAccessGroup: {
        id: params.account.id,
        loginEmail: params.account.loginEmail,
        accessGroup: this.normalizeAccessGroup(params.userInfo.accessGroup),
      },
      account: {
        id: params.account.id,
        loginName: params.account.loginName,
        loginEmail: params.account.loginEmail,
        status: params.account.status,
        identityHint: params.account.identityHint,
        createdAt: params.account.createdAt,
        updatedAt: params.account.updatedAt,
        credentialVersion: params.account.credentialVersion,
      },
      userInfo: {
        id: params.userInfo.id,
        accountId: params.userInfo.accountId,
        nickname: params.userInfo.nickname ?? '',
        avatarUrl: params.userInfo.avatarUrl,
        createdAt: params.userInfo.createdAt,
        updatedAt: params.userInfo.updatedAt,
      },
    };
  }

  private normalizeAccessGroup(accessGroup?: IdentityTypeEnum[] | null): IdentityTypeEnum[] {
    const validRoles = new Set<string>(Object.values(IdentityTypeEnum));
    const normalized = (accessGroup ?? []).filter((role): role is IdentityTypeEnum =>
      validRoles.has(String(role)),
    );
    return normalized.length > 0 ? Array.from(new Set(normalized)) : [IdentityTypeEnum.CUSTOMER];
  }
}
