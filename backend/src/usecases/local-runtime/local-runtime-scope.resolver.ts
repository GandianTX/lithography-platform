// src/usecases/local-runtime/local-runtime-scope.resolver.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { LocalRuntimeViewerScope } from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';
import { Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { resolveLocalRuntimeViewerScopeFromSession } from './local-runtime-scope';

/**
 * 本地运行数据查看者范围的用例侧解析器。
 *
 * 把「会话 → 管理员等级/可信公司 → core 策略裁决」的三步收敛为一个可注入服务，
 * 避免每个用例各自拼装事实来源（等级来自数据库复核、公司来自可信成员关系）。
 */
@Injectable()
export class LocalRuntimeScopeResolver {
  constructor(
    private readonly accountQueryService: AccountQueryService,
    private readonly trustedOrganizationContext: TrustedOrganizationContextQueryService,
  ) {}

  resolve(session: UsecaseSession): Promise<LocalRuntimeViewerScope> {
    return resolveLocalRuntimeViewerScopeFromSession({
      session,
      accountQueryService: this.accountQueryService,
      trustedOrganizationContext: this.trustedOrganizationContext,
    });
  }
}
