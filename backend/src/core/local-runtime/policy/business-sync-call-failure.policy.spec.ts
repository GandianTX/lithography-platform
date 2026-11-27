// src/core/local-runtime/policy/business-sync-call-failure.policy.spec.ts
/**
 * 业务同步**调用失败分类**的定向测试（任务 09 第 10 项 D8）。
 *
 * 守住两条：
 * 1. **网络类瞬时故障可重试**（不可达／超时／5xx ⇒ 退回待传）；
 * 2. **终态失败不再重试**（云端明确拒绝／回包非法／本机载荷不合规）。
 */
import { BUSINESS_SYNC_ERROR } from '@core/common/errors/domain-error';

import {
  BUSINESS_SYNC_CALL_FAILURE_CODES,
  decideBusinessSyncCallFailure,
  isBusinessSyncCallFailureCode,
} from './business-sync-call-failure.policy';

describe('业务同步调用失败分类', () => {
  it('不可达／超时／5xx ⇒ 可重试（退回待传）', () => {
    for (const code of [
      BUSINESS_SYNC_CALL_FAILURE_CODES.BUSINESS_SYNC_UNREACHABLE,
      BUSINESS_SYNC_CALL_FAILURE_CODES.BUSINESS_SYNC_TIMEOUT,
      BUSINESS_SYNC_CALL_FAILURE_CODES.BUSINESS_SYNC_SERVER_ERROR,
    ]) {
      const decision = decideBusinessSyncCallFailure(code);
      expect(decision.kind).toBe('RETRYABLE');
      expect(decision.errorCode).toBe(BUSINESS_SYNC_ERROR.RECEIVER_UNREACHABLE);
    }
  });

  it('未配置 ⇒ 可重试（任务留在待传，与接收端缺失同一语义）', () => {
    const decision = decideBusinessSyncCallFailure(
      BUSINESS_SYNC_CALL_FAILURE_CODES.BUSINESS_SYNC_NOT_CONFIGURED,
    );
    expect(decision.kind).toBe('RETRYABLE');
    expect(decision.errorCode).toBe(BUSINESS_SYNC_ERROR.RECEIVER_MISSING);
  });

  it('云端明确拒绝（4xx）⇒ 终态（重试无用）', () => {
    const decision = decideBusinessSyncCallFailure(
      BUSINESS_SYNC_CALL_FAILURE_CODES.BUSINESS_SYNC_REJECTED,
    );
    expect(decision.kind).toBe('TERMINAL');
    expect(decision.errorCode).toBe(BUSINESS_SYNC_ERROR.RECEIVER_REJECTED);
  });

  it('回包非法／本机载荷不合规 ⇒ 终态', () => {
    for (const code of [
      BUSINESS_SYNC_CALL_FAILURE_CODES.BUSINESS_SYNC_INVALID_RESPONSE,
      BUSINESS_SYNC_CALL_FAILURE_CODES.BUSINESS_SYNC_INVALID_PAYLOAD,
    ]) {
      const decision = decideBusinessSyncCallFailure(code);
      expect(decision.kind).toBe('TERMINAL');
      expect(decision.errorCode).toBe(BUSINESS_SYNC_ERROR.DISPATCH_REJECTED);
    }
  });

  it('未知错误码 ⇒ 按可重试处理（但不伪造成功）', () => {
    const decision = decideBusinessSyncCallFailure('SOMETHING_ELSE');
    expect(decision.kind).toBe('RETRYABLE');
    expect(decision.errorCode).toBe(BUSINESS_SYNC_ERROR.RECEIVER_UNREACHABLE);
  });

  it('受控码形态校验：非受控值不被认成受控码', () => {
    expect(
      isBusinessSyncCallFailureCode(BUSINESS_SYNC_CALL_FAILURE_CODES.BUSINESS_SYNC_TIMEOUT),
    ).toBe(true);
    expect(isBusinessSyncCallFailureCode('NOT_A_CODE')).toBe(false);
    expect(isBusinessSyncCallFailureCode(null)).toBe(false);
  });

  it('说明文案不含地址、凭据与正文', () => {
    const decision = decideBusinessSyncCallFailure(
      BUSINESS_SYNC_CALL_FAILURE_CODES.BUSINESS_SYNC_UNREACHABLE,
    );
    expect(decision.message).not.toMatch(/https?:\/\//);
    expect(decision.message).not.toMatch(/credential|token|secret/i);
  });
});
