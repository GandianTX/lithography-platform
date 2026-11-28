// src/usecases/auth/resolve-web-session.usecase.ts

import type { AuthenticatedSessionUser } from '@app-types/auth/session-restriction.types';
import { AudienceTypeEnum } from '@app-types/models/account.types';
import { Injectable } from '@nestjs/common';
import { TokenHelper } from '@modules/auth/token.helper';
import { ValidateAccessTokenSessionUsecase } from './validate-access-token-session.usecase';

/**
 * 浏览器会话恢复的令牌解析用例。
 *
 * 职责边界（与 Bearer 链路逐项对齐，不因为令牌来自 Cookie 而放宽）：
 * 1. 验签 + 签发者 + **受众必须是网页受众**（`SSTSWEB`）+ 有效期；
 * 2. 交给 `ValidateAccessTokenSessionUsecase` 做账号存在性、双状态、角色集、凭据代次
 *    等每请求复核（门禁 1~7），恢复路径不复制也不跳过任何一条；
 * 3. 只读：不重签、不延长有效期、不写登录历史、不读写任何 Cookie。
 *
 * 因此本用例返回的就是「Cookie 里的原令牌 + 当前可信身份」，调用方不得再签发新令牌。
 * 拒绝时的错误语义与 Bearer 链路一致：一律 `JWT_ERROR.*`（REST 映射 401），
 * 数据库等非领域异常不受本用例改写（保持服务错误，不冒充未登录）。
 */
@Injectable()
export class ResolveWebSessionUsecase {
  constructor(
    private readonly tokenHelper: TokenHelper,
    private readonly validateAccessTokenSessionUsecase: ValidateAccessTokenSessionUsecase,
  ) {}

  async execute(input: {
    readonly token: string;
    readonly issuer?: string;
  }): Promise<{ accessToken: string; session: AuthenticatedSessionUser }> {
    const payload = this.tokenHelper.verifyTokenSilently({
      token: input.token,
      audience: AudienceTypeEnum.SSTSWEB,
      issuer: input.issuer,
    });

    const session = await this.validateAccessTokenSessionUsecase.execute({ payload });

    return { accessToken: input.token, session };
  }
}
