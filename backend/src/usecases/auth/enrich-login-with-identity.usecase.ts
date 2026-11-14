// src/usecases/auth/enrich-login-with-identity.usecase.ts

import {
  EnrichedLoginResult,
  EnrichLoginWithIdentityInput,
  IEnrichLoginWithIdentityUsecase,
  LoginWarningType,
} from '@app-types/auth/login-flow.types';
import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { LoginResultQueryService } from '@modules/auth/queries/login-result.query.service';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

@Injectable()
export class EnrichLoginWithIdentityUsecase implements IEnrichLoginWithIdentityUsecase {
  constructor(
    private readonly loginResultQueryService: LoginResultQueryService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EnrichLoginWithIdentityUsecase.name);
  }

  execute(input: EnrichLoginWithIdentityInput): Promise<EnrichedLoginResult> {
    const {
      tokens,
      accountId,
      finalRole,
      accessGroup,
      account,
      userInfo,
      restriction,
      adminLevel,
      customerOrganizationId,
      options = {},
    } = input;
    const { includeAccount = true, includeUserInfo = true } = options;
    const warnings: LoginWarningType[] = [];

    const result = this.loginResultQueryService.toEnrichedLoginResult({
      tokens,
      accountId,
      finalRole,
      accessGroup,
      account,
      userInfo,
      identity: null,
      warnings,
      includeAccount,
      includeUserInfo,
      restriction: restriction ?? SessionRestriction.NONE,
      adminLevel: adminLevel ?? null,
      customerOrganizationId: customerOrganizationId ?? null,
    });

    this.logEnrichmentCompletion(accountId, finalRole, warnings);
    return Promise.resolve(result);
  }

  private logEnrichmentCompletion(
    accountId: number,
    finalRole: IdentityTypeEnum,
    warnings: LoginWarningType[],
  ): void {
    this.logger.info(
      {
        accountId,
        finalRole,
        hasIdentity: false,
        warningsCount: warnings.length,
        warnings,
      },
      `账户 ${accountId} 登录信息装配完成`,
    );
  }
}
