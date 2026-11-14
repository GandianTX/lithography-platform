// src/adapters/api/graphql/guards/session-restriction.guard.ts

import { type AuthenticatedSessionUser } from '@app-types/auth/session-restriction.types';
import { DomainError, JWT_ERROR } from '@core/common/errors/domain-error';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { Request } from 'express';

import { assertSessionRestrictionAllowsBusiness } from './session-restriction.assert';

interface GraphQLContext {
  req: Request & { user?: AuthenticatedSessionUser };
}

/**
 * 受限会话守卫：拦截仅挂 `JwtAuthGuard` 的业务入口。
 *
 * `RolesGuard` 只覆盖带 `@Roles()` 的入口；历史上有大量业务查询/写入只依赖
 * `JwtAuthGuard`，受限会话（必须改密 / 工程师待审 / 工程师拒绝）会直接穿透。
 * 本守卫与 `JwtAuthGuard` 组合使用（`@UseGuards(JwtAuthGuard, SessionRestrictionGuard)`），
 * 在认证通过后拒绝一切非 `NONE` 的 restriction。
 *
 * 刻意**不**挂到 `changeMyPassword` / `myAccountSettings` / `mySessionIdentity`：
 * 受限用户需要能改密、读取自身设置并在受限页展示原因。
 */
@Injectable()
export class SessionRestrictionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = this.getRequest(context);
    const user = request.user;
    if (!user) {
      // 正常链路中 JwtAuthGuard 先行；缺失用户时按未认证失败关闭
      throw new DomainError(JWT_ERROR.AUTHENTICATION_FAILED, '用户未登录');
    }

    assertSessionRestrictionAllowsBusiness(user);

    return true;
  }

  private getRequest(context: ExecutionContext): Request & { user?: AuthenticatedSessionUser } {
    if (context.getType() === 'http') {
      return context.switchToHttp().getRequest<Request & { user?: AuthenticatedSessionUser }>();
    }

    if (context.getType<GqlContextType>() === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      const gqlContext = gqlCtx.getContext<GraphQLContext>();
      return gqlContext.req;
    }

    throw new DomainError(JWT_ERROR.AUTHENTICATION_FAILED, '不支持的上下文类型', {
      contextType: context.getType(),
    });
  }
}
