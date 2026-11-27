// src/core/local-runtime/policy/local-authorization-renewal.policy.spec.ts

import { SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import {
  MAX_CLAIM_KEY_DEPTH,
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

  // review M9：授权材料改白名单，并去掉「深度 >8 即停止扫描」的绕过口
  describe('白名单口径', () => {
    it('白名单内的键通过', () => {
      expect(() =>
        validateAuthorizationRenewalInput({
          ...validInput,
          signedClaims: {
            sub: 'account-16',
            iss: 'https://cloud.example',
            aud: 'local-runtime',
            exp: 1_800_000_000,
            iat: 1_700_000_000,
            scopes: ['repair:read'],
            permissionVersion: 3,
            organizationId: 4,
            role: 'ENGINEER',
            adminLevel: null,
          },
        }),
      ).not.toThrow();
    });

    it('敏感键变体被拒：api_key／jwt／passwd／token', () => {
      for (const key of ['api_key', 'apikey', 'jwt', 'passwd', 'token', 'credential']) {
        expectPolicyError(
          () =>
            validateAuthorizationRenewalInput({
              ...validInput,
              signedClaims: { sub: 'account-16', [key]: 'x' },
            }),
          SYNC_ERROR.CLAIMS_FORBIDDEN_MATERIAL,
        );
      }
    });

    it('不在白名单内的键被拒（默认拒绝，不靠黑名单兜底）', () => {
      expectPolicyError(
        () =>
          validateAuthorizationRenewalInput({
            ...validInput,
            signedClaims: { sub: 'account-16', nickname: '张三' },
          }),
        SYNC_ERROR.CLAIMS_FORBIDDEN_MATERIAL,
      );
    });

    it('嵌套深处的敏感键同样被拒（不再靠深度截断放过）', () => {
      expectPolicyError(
        () =>
          validateAuthorizationRenewalInput({
            ...validInput,
            signedClaims: { meta: { list: [{ deeper: { deepest: { api_key: 'x' } } }] } },
          }),
        SYNC_ERROR.CLAIMS_FORBIDDEN_MATERIAL,
      );
    });

    it('嵌套层级过深直接拒绝（fail closed，不再静默停止扫描）', () => {
      let nested: Record<string, unknown> = { api_key: 'x' };
      for (let level = 0; level < MAX_CLAIM_KEY_DEPTH + 2; level += 1) {
        nested = { level: nested };
      }
      expectPolicyError(
        () => validateAuthorizationRenewalInput({ ...validInput, signedClaims: nested }),
        SYNC_ERROR.CLAIMS_FORBIDDEN_MATERIAL,
      );
    });
  });
});
