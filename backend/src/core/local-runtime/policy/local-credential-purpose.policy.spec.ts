// src/core/local-runtime/policy/local-credential-purpose.policy.spec.ts
/// <reference types="jest" />

/**
 * 凭据用途维度的定向测试（任务 09 S4 第 2 条）。
 *
 * 守住："不复用业务同步授权"——云备份只认云备份用途的凭据；
 * 用途不可核验（声明缺失/不可解析/无已知用途）一律不算数。
 */

import {
  LOCAL_CREDENTIAL_PURPOSE,
  hasCredentialPurpose,
  resolveCredentialPurposes,
} from './local-credential-purpose.policy';

describe('凭据用途维度（S4）', () => {
  it('声明里列出云备份用途 → 可用于云备份', () => {
    const claims = JSON.stringify({ purpose: ['CLOUD_BACKUP'] });
    expect(hasCredentialPurpose(claims, LOCAL_CREDENTIAL_PURPOSE.CLOUD_BACKUP)).toBe(true);
    expect(hasCredentialPurpose(claims, LOCAL_CREDENTIAL_PURPOSE.BUSINESS_SYNC)).toBe(false);
  });

  it('只有业务同步用途 → 不得用于云备份', () => {
    const claims = JSON.stringify({ purpose: ['BUSINESS_SYNC'] });
    expect(hasCredentialPurpose(claims, LOCAL_CREDENTIAL_PURPOSE.CLOUD_BACKUP)).toBe(false);
    expect(hasCredentialPurpose(claims, LOCAL_CREDENTIAL_PURPOSE.BUSINESS_SYNC)).toBe(true);
  });

  it('一份声明可覆盖多用途', () => {
    const claims = JSON.stringify({ purpose: ['BUSINESS_SYNC', 'CLOUD_BACKUP'] });
    expect(hasCredentialPurpose(claims, LOCAL_CREDENTIAL_PURPOSE.CLOUD_BACKUP)).toBe(true);
    expect(hasCredentialPurpose(claims, LOCAL_CREDENTIAL_PURPOSE.BUSINESS_SYNC)).toBe(true);
  });

  it('单字符串写法与未知用途值：未知丢弃，声明不可核验即不算数', () => {
    expect(
      hasCredentialPurpose(
        JSON.stringify({ purpose: 'CLOUD_BACKUP' }),
        LOCAL_CREDENTIAL_PURPOSE.CLOUD_BACKUP,
      ),
    ).toBe(true);
    expect(resolveCredentialPurposes(JSON.stringify({ purpose: ['WHATEVER'] }))).toEqual({
      purposes: [],
      verifiable: false,
    });
  });

  it('生产写入形态（对象）同样可核验：json 列读回来就是对象', () => {
    // 回归锁：写入侧要求"签名凭据必须是对象"，读取侧若只认 JSON 文本，
    // 生产形态的凭据会被判为不可核验 ⇒ 上云永远被跳过。
    const claims = { purpose: ['CLOUD_BACKUP'], issuer: 'cloud' };
    expect(hasCredentialPurpose(claims, LOCAL_CREDENTIAL_PURPOSE.CLOUD_BACKUP)).toBe(true);
    expect(hasCredentialPurpose(claims, LOCAL_CREDENTIAL_PURPOSE.BUSINESS_SYNC)).toBe(false);
    expect(resolveCredentialPurposes({ purpose: ['WHATEVER'] })).toEqual({
      purposes: [],
      verifiable: false,
    });
  });

  it('声明缺失或不可解析 → 用途不可核验（不得当作任一用途使用）', () => {
    expect(resolveCredentialPurposes(null)).toEqual({ purposes: [], verifiable: false });
    expect(resolveCredentialPurposes('not-json')).toEqual({ purposes: [], verifiable: false });
    expect(hasCredentialPurpose(null, LOCAL_CREDENTIAL_PURPOSE.CLOUD_BACKUP)).toBe(false);
  });
});
