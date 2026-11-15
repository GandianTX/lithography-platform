// src/adapters/api/graphql/guards/roles.guard.ts

import { JwtPayload } from '@app-types/jwt.types';
import { type AuthenticatedSessionUser } from '@app-types/auth/session-restriction.types';
import { DomainError, JWT_ERROR, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { Request } from 'express';

import { assertSessionRestrictionAllowsBusiness } from './session-restriction.assert';

/**
 * GraphQL 上下文类型定义
 */
interface GraphQLContext {
  req: Request & { user?: AuthenticatedSessionUser };
}

// 注意：角色装饰器统一定义在 src/adapters/api/graphql/decorators/roles.decorator.ts
// 该守卫不再重复定义 Roles 装饰器，避免混淆与重复实现。

/**
 * 角色权限守卫
 * 验证用户是否具有指定角色权限
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.getRequiredRoles(context);
    const user = this.getAuthenticatedUser(context, requiredRoles);

    // 受限会话（必须改密 / 工程师待审 / 工程师拒绝）只允许访问受限页所需的
    // 改密与自身会话入口，任何角色业务入口一律失败关闭
    assertSessionRestrictionAllowsBusiness(user);

    if (!requiredRoles) {
      return true;
    }

    if (requiredRoles.length === 0) {
      return this.handleEmptyRequiredRoles(user, requiredRoles);
    }

    this.assertValidAccessGroup(user, requiredRoles);
    this.validateActiveRole(user);
    this.assertHasAnyRequiredRole(user, requiredRoles);
    return true;
  }

  /**
   * 获取请求对象（支持 GraphQL 和 REST）
   */
  private getRequest(context: ExecutionContext): Request & { user?: AuthenticatedSessionUser } {
    if (context.getType() === 'http') {
      return context.switchToHttp().getRequest<Request & { user?: AuthenticatedSessionUser }>();
    }

    if (context.getType<GqlContextType>() === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      const gqlContext = gqlCtx.getContext<GraphQLContext>();
      return gqlContext.req;
    }

    // 容错处理：如果既不是 http 也不是 graphql，抛出错误
    throw new DomainError(JWT_ERROR.AUTHENTICATION_FAILED, '不支持的上下文类型', {
      contextType: context.getType(),
    });
  }

  /**
   * 读取角色要求元数据
   */
  private getRequiredRoles(context: ExecutionContext): string[] | undefined {
    return this.reflector.getAllAndOverride<string[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);
  }

  /**
   * 获取并校验认证用户
   */
  private getAuthenticatedUser(
    context: ExecutionContext,
    requiredRoles: string[] | undefined,
  ): AuthenticatedSessionUser {
    const request = this.getRequest(context);
    const user = request.user;
    if (!user) {
      throw new DomainError(JWT_ERROR.AUTHENTICATION_FAILED, '用户未登录', {
        requiredRoles: requiredRoles || [],
      });
    }
    return user;
  }

  /**
   * 处理 @Roles() 空数组场景
   */
  private handleEmptyRequiredRoles(user: JwtPayload, requiredRoles: string[]): boolean {
    if (!Array.isArray(user.accessGroup)) {
      throw new DomainError(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS, '用户权限数据格式异常', {
        requiredRoles,
        accessGroupType: typeof user.accessGroup,
        accessGroupValue: user.accessGroup,
      });
    }

    if (user.accessGroup.length === 0) {
      throw new DomainError(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS, '用户权限信息缺失', {
        requiredRoles,
      });
    }
    return true;
  }

  /**
   * 校验访问组格式与非空
   */
  private assertValidAccessGroup(user: JwtPayload, requiredRoles: string[]): void {
    if (!Array.isArray(user.accessGroup)) {
      throw new DomainError(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS, '用户权限数据格式异常', {
        requiredRoles,
        accessGroupType: typeof user.accessGroup,
        accessGroupValue: user.accessGroup,
      });
    }
    if (user.accessGroup.length === 0) {
      throw new DomainError(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS, '用户权限信息缺失', {
        requiredRoles,
      });
    }
  }

  /**
   * 校验 activeRole 一致性
   */
  private validateActiveRole(user: JwtPayload): void {
    const activeRole = (user as { activeRole?: string }).activeRole;
    if (!activeRole) return;
    const normalizedActiveRole = String(activeRole).toLowerCase();
    const normalizedUserRolesForCheck = user.accessGroup.map((role) =>
      typeof role === 'string' ? role.toLowerCase() : String(role).toLowerCase(),
    );
    if (!normalizedUserRolesForCheck.includes(normalizedActiveRole)) {
      throw new DomainError(
        PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
        'activeRole 不在用户权限组中',
        {
          activeRole,
          userRoles: user.accessGroup,
        },
      );
    }
  }

  /**
   * 断言用户拥有至少一个所需角色
   */
  private assertHasAnyRequiredRole(user: JwtPayload, requiredRoles: string[]): void {
    const normalizedRequiredRoles = requiredRoles.map((role) => role.toLowerCase());
    const normalizedUserRoles = user.accessGroup.map((role) =>
      typeof role === 'string' ? role.toLowerCase() : String(role).toLowerCase(),
    );
    const hasRole = normalizedRequiredRoles.some((role) => normalizedUserRoles.includes(role));
    if (!hasRole) {
      throw new DomainError(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS, '缺少所需角色', {
        requiredRoles,
        userRoles: user.accessGroup,
      });
    }
  }
}
