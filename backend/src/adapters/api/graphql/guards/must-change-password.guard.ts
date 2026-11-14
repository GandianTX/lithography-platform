// src/adapters/api/graphql/guards/must-change-password.guard.ts

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { resolveAuthenticatedSessionUser } from './authenticated-session-user';
import { assertNotPendingPasswordChange } from './session-restriction.assert';

/**
 * 强制改密门禁：只拒绝 `MUST_CHANGE_PASSWORD`，其余限制状态放行。
 *
 * 与 `SessionRestrictionGuard`（拒绝一切非 `NONE`）的分工：
 * - 账号设置读取 / 更新、本人工程师申请读取需要允许「工程师待审 / 已拒绝 / 资格未生效」
 *   的受限会话维护本人资料，但**不能**在强制改密完成前进行；
 * - 一般业务入口继续使用 `SessionRestrictionGuard`。
 *
 * 必须与 `JwtAuthGuard` 组合使用（`@UseGuards(JwtAuthGuard, MustChangePasswordGuard)`）。
 */
@Injectable()
export class MustChangePasswordGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    assertNotPendingPasswordChange(resolveAuthenticatedSessionUser(context));
    return true;
  }
}
