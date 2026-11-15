// src/adapters/api/graphql/strategies/jwt.strategy.ts
import type { JwtPayload } from '@app-types/jwt.types';
import type { AuthenticatedSessionUser } from '@app-types/auth/session-restriction.types';
import { Inject, Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ValidateAccessTokenSessionUsecase } from '@src/usecases/auth/validate-access-token-session.usecase';
import { PinoLogger } from 'nestjs-pino';
import { ExtractJwt, type JwtFromRequestFunction, Strategy } from 'passport-jwt';
import { JWT_STRATEGY_OPTIONS, type JwtStrategyOptions } from './jwt-strategy.options';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @Inject(JWT_STRATEGY_OPTIONS)
    options: JwtStrategyOptions,
    private readonly validateAccessTokenSessionUsecase: ValidateAccessTokenSessionUsecase,
    private readonly logger: PinoLogger,
  ) {
    const jwtExtractor: JwtFromRequestFunction = ExtractJwt.fromAuthHeaderAsBearerToken();

    super({
      jwtFromRequest: jwtExtractor,
      ignoreExpiration: false,
      secretOrKey: options.secret,
      issuer: options.issuer,
      audience: options.audience,
    });

    this.logger.setContext(JwtStrategy.name);
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedSessionUser> {
    return await this.validateAccessTokenSessionUsecase.execute({ payload });
  }
}
