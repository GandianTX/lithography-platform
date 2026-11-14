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
