// src/core/local-runtime/policy/local-authorization-renewal.policy.spec.ts

import { SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import {
  collectClaimKeys,
  isForbiddenClaimKey,
  isRenewalAllowed,
  validateAuthorizationRenewalInput,
} from './local-authorization-renewal.policy';

/**
 * R067：不得把密码／密钥写入凭据、快照、日志或冲突页。
 * 续期载荷在进入本地事实前先做键级拒绝。
 */

/** DomainError 的 code 不进 message：统一用 try/catch 断言错误码 */
function expectPolicyError(action: () => void, code: string): void {
  expect(action).toThrow(DomainError);
  try {
    action();
  } catch (error) {
    expect((error as DomainError).code).toBe(code);
  }
}

describe('local authorization renewal policy', () => {
  const validInput = {
    signedClaims: { sub: 'account-16', permissionVersion: 3, scopes: ['repair:read'] },
    permissionVersion: 3,
    lastVerifiedAt: new Date('2026-11-19T00:00:00.000Z'),
  };

  it('合法载荷通过', () => {
    expect(() => validateAuthorizationRenewalInput(validInput)).not.toThrow();
  });

  it('非对象载荷拒绝（数组/标量/null）', () => {
    expectPolicyError(
      () => validateAuthorizationRenewalInput({ ...validInput, signedClaims: [] }),
      SYNC_ERROR.CLAIMS_INVALID,
    );
    expectPolicyError(
      () => validateAuthorizationRenewalInput({ ...validInput, signedClaims: 'x' }),
      SYNC_ERROR.CLAIMS_INVALID,
    );
    expectPolicyError(
      () => validateAuthorizationRenewalInput({ ...validInput, signedClaims: null }),
      SYNC_ERROR.CLAIMS_INVALID,
    );
  });

  it('密码类键拒绝（含大小写与变体）', () => {
    // 用 JSON.parse 构造大小写变体键，避免对象字面量触发命名约定规则
    const claimsWithPassword = JSON.parse('{"Password":"x"}') as Record<string, unknown>;
    expectPolicyError(
      () => validateAuthorizationRenewalInput({ ...validInput, signedClaims: claimsWithPassword }),
      SYNC_ERROR.CLAIMS_FORBIDDEN_MATERIAL,
    );
    expectPolicyError(
      () =>
        validateAuthorizationRenewalInput({ ...validInput, signedClaims: { password_hash: 'x' } }),
      SYNC_ERROR.CLAIMS_FORBIDDEN_MATERIAL,
    );
  });

  it('令牌与密钥类键拒绝，含嵌套对象', () => {
    expectPolicyError(
      () =>
        validateAuthorizationRenewalInput({
          ...validInput,
          signedClaims: { claims: { refreshToken: 'x' } },
        }),
      SYNC_ERROR.CLAIMS_FORBIDDEN_MATERIAL,
    );
    expectPolicyError(
      () =>
        validateAuthorizationRenewalInput({
          ...validInput,
          signedClaims: { meta: { list: [{ encryptionKey: 'x' }] } },
        }),
      SYNC_ERROR.CLAIMS_FORBIDDEN_MATERIAL,
    );
  });

  it('权限版本必须为不小于 1 的整数（对齐 DB CHECK）', () => {
    expectPolicyError(
      () => validateAuthorizationRenewalInput({ ...validInput, permissionVersion: 0 }),
      SYNC_ERROR.CLAIMS_INVALID,
    );
    expectPolicyError(
      () => validateAuthorizationRenewalInput({ ...validInput, permissionVersion: 1.5 }),
      SYNC_ERROR.CLAIMS_INVALID,
    );
  });

  it('最近校验时间必须是有效 Date', () => {
    expectPolicyError(
      () =>
        validateAuthorizationRenewalInput({
          ...validInput,
          lastVerifiedAt: new Date('not-a-date'),
        }),
      SYNC_ERROR.CLAIMS_INVALID,
    );
  });

  it('仅 ACTIVE 行可续期；REVOKED 必须重新授权', () => {
    expect(isRenewalAllowed('ACTIVE')).toBe(true);
    expect(isRenewalAllowed('REVOKED')).toBe(false);
  });

  it('键收集覆盖嵌套对象与数组内对象', () => {
    expect(collectClaimKeys({ a: { b: { c: 1 } } })).toEqual(['a', 'b', 'c']);
    expect(collectClaimKeys({ a: [{ d: 1 }] })).toEqual(['a', 'd']);
    expect(isForbiddenClaimKey(' RefreshToken ')).toBe(true);
    expect(isForbiddenClaimKey('scope')).toBe(false);
  });
});
