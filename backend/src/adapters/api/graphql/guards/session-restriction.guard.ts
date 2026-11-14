// src/adapters/api/graphql/guards/session-restriction.guard.ts

import { type AuthenticatedSessionUser } from '@app-types/auth/session-restriction.types';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { resolveAuthenticatedSessionUser } from './authenticated-session-user';
import { assertSessionRestrictionAllowsBusiness } from './session-restriction.assert';

/**
 * 受限会话守卫：拦截仅挂 `JwtAuthGuard` 的业务入口。
 *
 * `RolesGuard` 只覆盖带 `@Roles()` 的入口；历史上有大量业务查询/写入只依赖
 * `JwtAuthGuard`，受限会话（必须改密 / 工程师待审 / 工程师拒绝 / 工程师资格未生效）
 * 会直接穿透。本守卫与 `JwtAuthGuard` 组合使用
 * （`@UseGuards(JwtAuthGuard, SessionRestrictionGuard)`），在认证通过后拒绝一切非 `NONE`
 * 的 restriction。
 *
 * 刻意**不**挂到 `changeMyPassword` / `mySessionIdentity`，也不挂到
 * `myAccountSettings` / `updateMyAccountSettings`——受限用户需要能改密、读取自身设置
 * 并在受限页展示原因；这两个账号设置入口由更窄的 `MustChangePasswordGuard` 把关。
 */
@Injectable()
export class SessionRestrictionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user: AuthenticatedSessionUser = resolveAuthenticatedSessionUser(context);
    assertSessionRestrictionAllowsBusiness(user);
    return true;
  }
}
