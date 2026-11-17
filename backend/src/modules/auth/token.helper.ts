// src/modules/auth/token.helper.ts
import {
  GenerateAccessTokenParams,
  GenerateRefreshTokenParams,
  JwtPayload,
} from '@app-types/jwt.types';
import { Injectable } from '@nestjs/common';
import { JsonWebTokenError, JwtService, NotBeforeError, TokenExpiredError } from '@nestjs/jwt';
import { DomainError, JWT_ERROR } from '@core/common/errors/domain-error';
import { PinoLogger } from 'nestjs-pino';

@Injectable()
export class TokenHelper {
  constructor(
    private readonly jwtService: JwtService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(TokenHelper.name);
  }

  generateAccessToken({ payload, expiresIn, audience }: GenerateAccessTokenParams): string {
    try {
      const accessPayload = {
        ...payload,
        type: 'access',
      };

      const signOptions: Record<string, unknown> = {};

      if (expiresIn) {
        signOptions.expiresIn = expiresIn;
      }

      if (audience) {
        signOptions.audience = audience;
      }

      const token = this.jwtService.sign(accessPayload, signOptions);

      return token;
    } catch (error) {
      this.logger.error(
        {
          userId: payload.sub,
          tokenType: 'access',
          error: error instanceof Error ? error.message : '未知错误',
          payload,
        },
        'access token 生成失败',
      );

      throw new DomainError(
        JWT_ERROR.ACCESS_TOKEN_GENERATION_FAILED,
        `access token 生成失败: ${error instanceof Error ? error.message : '未知错误'}`,
        { userId: payload.sub, tokenType: 'access' },
        error,
      );
    }
  }

  generateRefreshToken({
    payload,
    tokenVersion = 1,
    audience,
  }: GenerateRefreshTokenParams): string {
    try {
      const refreshPayload = {
        sub: payload.sub,
        type: 'refresh',
        tokenVersion: tokenVersion,
      };

      const signOptions: Record<string, unknown> = {};

      if (audience) {
        signOptions.audience = audience;
      }

      const token = this.jwtService.sign(refreshPayload, signOptions);

      return token;
    } catch (error) {
      this.logger.error(
        {
          userId: payload.sub,
          tokenType: 'refresh',
          error: error instanceof Error ? error.message : '未知错误',
          payload,
        },
        'refresh token 生成失败',
      );

      throw new DomainError(
        JWT_ERROR.REFRESH_TOKEN_GENERATION_FAILED,
        `refresh token 生成失败: ${error instanceof Error ? error.message : '未知错误'}`,
        { userId: payload.sub, tokenType: 'refresh' },
        error,
      );
    }
  }

  validateAudience(audience: string, configAudience: string): boolean {
    if (!audience || !configAudience) {
      return false;
    }

    const allowedAudiences = configAudience.split(',').map((aud) => aud.trim());
    return allowedAudiences.includes(audience);
  }

  verifyToken({ token }: { token: string }): JwtPayload {
    try {
      const payload = this.jwtService.verify<JwtPayload>(token);

      return payload;
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        throw new DomainError(
          JWT_ERROR.TOKEN_EXPIRED,
          `Token 已过期: ${error instanceof Error ? error.message : 'Token 已过期'}`,
          { tokenPrefix: token.substring(0, 20) + '...' },
          error,
        );
      }

      if (error instanceof NotBeforeError) {
        this.logger.error(
          {
            error: error instanceof Error ? error.message : 'Token 未生效',
            tokenPrefix: token.substring(0, 20) + '...',
            timestamp: new Date().toISOString(),
          },
          'JWT Token 手动验证失败 - 关注潜在的安全问题',
        );

        throw new DomainError(
          JWT_ERROR.TOKEN_NOT_BEFORE,
          `Token 验证失败: ${error instanceof Error ? error.message : 'Token 未生效'}`,
          { tokenPrefix: token.substring(0, 20) + '...' },
          error,
        );
      }

      if (error instanceof JsonWebTokenError) {
        this.logger.error(
          {
            error: error instanceof Error ? error.message : '非法 token，结构错误、伪造等',
            tokenPrefix: token.substring(0, 20) + '...',
            timestamp: new Date().toISOString(),
          },
          'JWT Token 手动验证失败 - 关注潜在的安全问题',
        );

        throw new DomainError(
          JWT_ERROR.TOKEN_INVALID,
          `Token 验证失败: ${error instanceof Error ? error.message : '非法 token'}`,
          { tokenPrefix: token.substring(0, 20) + '...' },
          error,
        );
      }

      throw new DomainError(
        JWT_ERROR.TOKEN_VERIFICATION_FAILED,
        `Token 验证失败: ${error instanceof Error ? error.message : '未知错误'}`,
        { tokenPrefix: token.substring(0, 20) + '...' },
        error,
      );
    }
  }

  decodeToken({ token }: { token: string }): JwtPayload | null {
    try {
      const payload = this.jwtService.decode<JwtPayload>(token);
      return payload;
    } catch {
      return null;
    }
  }

  isTokenExpiringSoon({
    token,
    thresholdMinutes = 15,
  }: {
    token: string;
    thresholdMinutes?: number;
  }): boolean {
    try {
      const payload = this.decodeToken({ token });
      if (!payload?.exp) {
        return false;
      }

      const now = Math.floor(Date.now() / 1000);
      const threshold = thresholdMinutes * 60;
      const isExpiringSoon = payload.exp - now <= threshold;

      return isExpiringSoon;
    } catch {
      return true;
    }
  }

  createPayloadFromUser({
    id,
    nickname,
    loginEmail,
    accessGroup,
    credentialVersion,
  }: {
    id: number;
    nickname: string;
    loginEmail: string | null;
    accessGroup: string[];
    credentialVersion?: number;
  }): Pick<JwtPayload, 'sub' | 'username' | 'email' | 'accessGroup' | 'credentialVersion'> {
    const payload: Pick<
      JwtPayload,
      'sub' | 'username' | 'email' | 'accessGroup' | 'credentialVersion'
    > = {
      sub: id,
      username: nickname,
      email: loginEmail,
      accessGroup: accessGroup,
      ...(credentialVersion === undefined ? {} : { credentialVersion }),
    };
    return payload;
  }
}
