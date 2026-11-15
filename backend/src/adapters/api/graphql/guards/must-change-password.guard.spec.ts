// src/adapters/api/graphql/guards/must-change-password.guard.spec.ts

import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import { type ExecutionContext } from '@nestjs/common';

import { MustChangePasswordGuard } from './must-change-password.guard';

function httpContext(user?: unknown): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('MustChangePasswordGuard', () => {
  const guard = new MustChangePasswordGuard();

  const user = (restriction: SessionRestriction) => ({
    accountId: 7,
    role: IdentityTypeEnum.ENGINEER,
    adminLevel: null,
    customerOrganizationId: null,
    engineerOrganizationId: null,
    adminOrganizationId: null,
    registrationOrganizationId: null,
    restriction,
    accountStatus: AccountStatus.ACTIVE,
  });

  it('必须改密的会话被拒绝', () => {
    expect(() =>
      guard.canActivate(httpContext(user(SessionRestriction.MUST_CHANGE_PASSWORD))),
    ).toThrow(DomainError);

    try {
      guard.canActivate(httpContext(user(SessionRestriction.MUST_CHANGE_PASSWORD)));
    } catch (error) {
      expect((error as DomainError).code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
    }
  });

  it.each([
    SessionRestriction.NONE,
    SessionRestriction.ENGINEER_PENDING,
    SessionRestriction.ENGINEER_REJECTED,
    SessionRestriction.ENGINEER_INACTIVE,
  ])('restriction=%s 时放行', (restriction) => {
    expect(guard.canActivate(httpContext(user(restriction)))).toBe(true);
  });

  it('缺失会话用户时按未认证失败关闭', () => {
    expect(() => guard.canActivate(httpContext(undefined))).toThrow(DomainError);
  });
});
