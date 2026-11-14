// src/adapters/api/graphql/guards/session-restriction.assert.spec.ts

import { SessionRestriction } from '@app-types/auth/session-restriction.types';
import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';

import {
  assertSessionRestrictionAllowsBusiness,
  assertNotPendingPasswordChange,
} from './session-restriction.assert';

function catchDomainError(run: () => void): DomainError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error('预期抛出 DomainError，但调用正常返回');
}

describe('assertSessionRestrictionAllowsBusiness（受限会话业务拦截）', () => {
  it('未携带 restriction 的载体按正常会话放行（历史 Token 兼容口径）', () => {
    expect(() => assertSessionRestrictionAllowsBusiness({})).not.toThrow();
  });

  it('restriction 为 NONE 时放行', () => {
    expect(() =>
      assertSessionRestrictionAllowsBusiness({ restriction: SessionRestriction.NONE }),
    ).not.toThrow();
  });

  it.each([
    SessionRestriction.MUST_CHANGE_PASSWORD,
    SessionRestriction.ENGINEER_PENDING,
    SessionRestriction.ENGINEER_REJECTED,
    SessionRestriction.ENGINEER_INACTIVE,
  ])('restriction 为 %s 时以权限不足失败关闭，并携带具体限制状态', (restriction) => {
    const error = catchDomainError(() => assertSessionRestrictionAllowsBusiness({ restriction }));

    expect(error.code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
    expect(error.details).toEqual({ restriction });
  });
});

describe('assertNotPendingPasswordChange（强制改密门禁）', () => {
  it.each([
    ['未携带 restriction', {}],
    ['NONE', { restriction: SessionRestriction.NONE }],
    ['工程师待审', { restriction: SessionRestriction.ENGINEER_PENDING }],
    ['工程师拒绝', { restriction: SessionRestriction.ENGINEER_REJECTED }],
    ['工程师资格未生效', { restriction: SessionRestriction.ENGINEER_INACTIVE }],
  ])('%s 时放行，允许受限用户维护本人资料', (_label, user) => {
    expect(() => assertNotPendingPasswordChange(user)).not.toThrow();
  });

  it('MUST_CHANGE_PASSWORD 时以权限不足失败关闭', () => {
    const error = catchDomainError(() =>
      assertNotPendingPasswordChange({ restriction: SessionRestriction.MUST_CHANGE_PASSWORD }),
    );

    expect(error.code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
    expect(error.details).toEqual({ restriction: SessionRestriction.MUST_CHANGE_PASSWORD });
  });
});
