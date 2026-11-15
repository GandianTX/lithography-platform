// e2e/helpers/registration-capture-diagnosis.spec.ts
// 第三轮 P2：响应接管结论分类与收尾诊断的纯函数单测（不启浏览器、不连数据库）。

import { describe, expect, it } from 'vitest';

import {
  buildRegistrationAttemptProbeSql,
  describeCaptureDiagnosis,
  readRegistrationAccountFromResponse,
  type RegistrationCaptureOutcome,
} from './registration-capture-diagnosis';

const captureWith = (outcome: RegistrationCaptureOutcome | null): { outcome: typeof outcome } => ({
  outcome,
});

describe('readRegistrationAccountFromResponse', () => {
  it('成功响应：提取正整数账号 ID', () => {
    expect(
      readRegistrationAccountFromResponse({ data: { registerWeb: { accountId: 900303 } } }),
    ).toEqual({ accountId: 900303, kind: 'account' });
  });

  it('响应带 GraphQL errors：判为明确拒绝并保留首条 message', () => {
    expect(
      readRegistrationAccountFromResponse({
        data: { registerWeb: null },
        errors: [{ message: '该邮箱已被注册' }],
      }),
    ).toEqual({ detail: '该邮箱已被注册', kind: 'rejected' });
  });

  it('缺少 data.registerWeb：判为可能已提交但缺可核验响应', () => {
    const reading = readRegistrationAccountFromResponse({ data: {} });
    expect(reading.kind).toBe('unknown');
    expect(reading.kind === 'unknown' ? reading.detail : '').toContain('响应缺少有效账号 ID');
  });

  it.each([0, -1, 1.5, '900303', null])('非法账号 ID %s：判为未知', (accountId) => {
    expect(readRegistrationAccountFromResponse({ data: { registerWeb: { accountId } } }).kind).toBe(
      'unknown',
    );
  });
});

describe('describeCaptureDiagnosis', () => {
  it('没有接管（null）或已成功入账：不产生收尾诊断', () => {
    expect(describeCaptureDiagnosis(null, { loginEmail: 'e2e@example.com' })).toBeNull();
    expect(
      describeCaptureDiagnosis(captureWith({ accountId: 12, kind: 'captured' }), {
        loginEmail: 'e2e@example.com',
      }),
    ).toBeNull();
  });

  it('明确拒绝：说明未创建账号并带上本轮登录邮箱', () => {
    const text = describeCaptureDiagnosis(
      captureWith({ detail: '该邮箱已被注册', kind: 'rejected' }),
      {
        loginEmail: 'e2e@example.com',
      },
    );
    expect(text).toContain('明确拒绝');
    expect(text).toContain('未创建账号');
    expect(text).toContain('loginEmail=e2e@example.com');
  });

  it('已取得账号 ID 但关联核验失败：带上账号 ID 与原始原因', () => {
    const text = describeCaptureDiagnosis(
      captureWith({ accountId: 900303, detail: '资料归属不符', kind: 'unverified' }),
      { loginEmail: 'e2e@example.com' },
    );
    expect(text).toContain('账号 ID 900303');
    expect(text).toContain('资料归属不符');
    expect(text).toContain('loginEmail=e2e@example.com');
  });

  it('提交结果待确认：明确不按业务名称推导删除', () => {
    const text = describeCaptureDiagnosis(
      captureWith({ detail: 'page.waitForResponse: Timeout 5000ms exceeded', kind: 'unknown' }),
      { loginEmail: 'e2e@example.com' },
    );
    expect(text).toContain('提交结果待确认');
    expect(text).toContain('Timeout 5000ms exceeded');
    expect(text).toContain('loginEmail=e2e@example.com');
    expect(text).toContain('不按业务名称推导删除');
  });
});

describe('buildRegistrationAttemptProbeSql', () => {
  it('只读：仅 SELECT，不含任何写操作', () => {
    const sql = buildRegistrationAttemptProbeSql('e2e.fault.abc.f@example.com');
    expect(sql).toContain("WHERE login_email = 'e2e.fault.abc.f@example.com'");
    expect(sql).not.toMatch(/\b(DELETE|UPDATE|INSERT|TRUNCATE)\b/i);
  });

  it('拒绝任何疑似拼接注入的输入', () => {
    expect(() => buildRegistrationAttemptProbeSql("x' OR 1=1 --@example.com")).toThrow(
      /只接受合成登录邮箱/,
    );
    expect(() => buildRegistrationAttemptProbeSql('no-at-sign')).toThrow(/只接受合成登录邮箱/);
  });
});
