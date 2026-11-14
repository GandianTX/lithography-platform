// src/adapters/api/graphql/guards/authenticated-session-user.ts

import { type AuthenticatedSessionUser } from '@app-types/auth/session-restriction.types';
import { DomainError, JWT_ERROR } from '@core/common/errors/domain-error';
import { ExecutionContext } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { Request } from 'express';

interface GraphQLContext {
  req: Request & { user?: AuthenticatedSessionUser };
}

type AuthenticatedRequest = Request & { user?: AuthenticatedSessionUser };

/**
 * 从执行上下文取出 `JwtAuthGuard` 写入的会话用户（HTTP / GraphQL 两种上下文）。
 *
 * 多个守卫共用同一份上下文提取，避免「HTTP 走 switchToHttp、GraphQL 走
 * GqlExecutionContext」的胶水代码在守卫之间各写一份而漂移；缺失用户按未认证失败关闭。
 */
export function resolveAuthenticatedSessionUser(
  context: ExecutionContext,
): AuthenticatedSessionUser {
  const request = getRequest(context);
  const user = request.user;
  if (!user) {
    // 正常链路中 JwtAuthGuard 先行；缺失用户时按未认证失败关闭
    throw new DomainError(JWT_ERROR.AUTHENTICATION_FAILED, '用户未登录');
  }
  return user;
}

function getRequest(context: ExecutionContext): AuthenticatedRequest {
  if (context.getType() === 'http') {
    return context.switchToHttp().getRequest<AuthenticatedRequest>();
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
