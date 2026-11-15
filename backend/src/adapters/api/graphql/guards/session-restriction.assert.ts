// src/adapters/api/graphql/guards/session-restriction.assert.ts

import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';

/**
 * 受限会话的业务入口拦截（RolesGuard 与 SessionRestrictionGuard 共用）。
 *
 * 两处若各写一份「restriction 非 NONE 即拒绝」的判断，错误码、文案或缺失值
 * 语义很容易漂移；集中到本函数，守卫只决定何时调用。
 */
export function assertSessionRestrictionAllowsBusiness(user: {
  readonly restriction?: SessionRestriction;
}): void {
  if (user.restriction !== undefined && user.restriction !== SessionRestriction.NONE) {
    throw new DomainError(
      PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      '当前会话受限，请先完成必要的账号操作',
      { restriction: user.restriction },
    );
  }
}

/**
 * 强制改密门禁（`MustChangePasswordGuard` 与凭据式入口共用）。
 *
 * 只拒绝 `MUST_CHANGE_PASSWORD`：待审 / 已拒绝 / 资格未生效的受限会话仍需维护本人
 * 昵称、电话与申请信息，且必须能看到自己为什么被限制；而强制改密未完成前的一切
 * 其他操作都必须失败关闭，否则「强制改密」可被绕过。
 */
export function assertNotPendingPasswordChange(user: {
  readonly restriction?: SessionRestriction;
}): void {
  if (user.restriction === SessionRestriction.MUST_CHANGE_PASSWORD) {
    throw new DomainError(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS, '当前账号需要先修改登录密码', {
      restriction: user.restriction,
    });
  }
}
