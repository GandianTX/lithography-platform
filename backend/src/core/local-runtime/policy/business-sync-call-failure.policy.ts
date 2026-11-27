// src/core/local-runtime/policy/business-sync-call-failure.policy.ts
/**
 * 业务同步**调用失败**的受控分类（任务 09 第 10 项 D8）。
 *
 * 为什么要有这一层：
 * - 此前派发链把接收端抛出的**所有**异常都压成同一个"接收端缺失"，并且一律"退回待传"。
 *   结果是两类完全不同的事实被混为一谈：
 *   ① 网络类瞬时故障（不可达／超时／5xx）——退回待传是对的；
 *   ② 云端**明确拒绝**（4xx）／回包形态非法／本机载荷不合规——重试多少次都不会变，
 *      退回待传只会让同一份载��**无限重试**。
 * - 受控失败码是**发送端与派发链的共同语言**：发送端产出受控码，派发链按受控码裁决
 *   "退回待传"还是"任务失败"，两侧不得各写一套映射。
 *
 * 口径边界：
 * - **未知错误码按可重试处理**（网络类瞬时故障占多数），但绝不因此伪造成功；
 * - "未配置"归入可重试：接收端未就绪时任务留在待传，与"生产接收端缺失"同一语义。
 */

import { BUSINESS_SYNC_ERROR } from '@core/common/errors/domain-error';

/** 业务同步调用失败码（发送端产出、派发链消费） */
export const BUSINESS_SYNC_CALL_FAILURE_CODES = {
  /** 云端入口未配置（地址或凭据缺失） */
  BUSINESS_SYNC_NOT_CONFIGURED: 'BUSINESS_SYNC_NOT_CONFIGURED',
  /** 云端不可达 */
  BUSINESS_SYNC_UNREACHABLE: 'BUSINESS_SYNC_UNREACHABLE',
  /** 云端请求超时 */
  BUSINESS_SYNC_TIMEOUT: 'BUSINESS_SYNC_TIMEOUT',
  /** 云端拒绝（4xx） */
  BUSINESS_SYNC_REJECTED: 'BUSINESS_SYNC_REJECTED',
  /** 云端异常（5xx） */
  BUSINESS_SYNC_SERVER_ERROR: 'BUSINESS_SYNC_SERVER_ERROR',
  /** 云端回包形态非法 */
  BUSINESS_SYNC_INVALID_RESPONSE: 'BUSINESS_SYNC_INVALID_RESPONSE',
  /** 本机待送载荷不合规（路径越界、清单与字节不一致等） */
  BUSINESS_SYNC_INVALID_PAYLOAD: 'BUSINESS_SYNC_INVALID_PAYLOAD',
} as const;

export type BusinessSyncCallFailureCode =
  (typeof BUSINESS_SYNC_CALL_FAILURE_CODES)[keyof typeof BUSINESS_SYNC_CALL_FAILURE_CODES];

/** 失败处置类别 */
export type BusinessSyncCallFailureKind =
  /** 可重试：退回待传，下一轮凭同一幂等键续传 */
  | 'RETRYABLE'
  /** 终态：重试无用，任务直接失败 */
  | 'TERMINAL';

/** 失败处置裁决 */
export type BusinessSyncCallFailureDecision = {
  readonly kind: BusinessSyncCallFailureKind;
  /** 落库用的受控错误码（`BUSINESS_SYNC_ERROR` 命名空间） */
  readonly errorCode: string;
  /** 面向用户的说明（不含地址、凭据与正文） */
  readonly message: string;
};

const ALL_CALL_FAILURE_CODES: readonly string[] = Object.values(BUSINESS_SYNC_CALL_FAILURE_CODES);

/** 是否是受控的调用失败码 */
export function isBusinessSyncCallFailureCode(
  value: unknown,
): value is BusinessSyncCallFailureCode {
  return typeof value === 'string' && ALL_CALL_FAILURE_CODES.includes(value);
}

/**
 * 失败处置裁决（纯函数）。
 *
 * @param code 发送端产出的受控失败码；未知码按**可重试**处理。
 */
export function decideBusinessSyncCallFailure(code: unknown): BusinessSyncCallFailureDecision {
  if (!isBusinessSyncCallFailureCode(code)) {
    // 未知错误：按瞬时故障处理（可重试），不伪造成功、也不落终态
    return {
      kind: 'RETRYABLE',
      errorCode: BUSINESS_SYNC_ERROR.RECEIVER_UNREACHABLE,
      message: '接收端调用失败，待传任务退回待传',
    };
  }
  switch (code) {
    case BUSINESS_SYNC_CALL_FAILURE_CODES.BUSINESS_SYNC_NOT_CONFIGURED:
      return {
        kind: 'RETRYABLE',
        errorCode: BUSINESS_SYNC_ERROR.RECEIVER_MISSING,
        message: '云端业务同步入口未就绪，待传任务退回待传',
      };
    case BUSINESS_SYNC_CALL_FAILURE_CODES.BUSINESS_SYNC_UNREACHABLE:
    case BUSINESS_SYNC_CALL_FAILURE_CODES.BUSINESS_SYNC_TIMEOUT:
    case BUSINESS_SYNC_CALL_FAILURE_CODES.BUSINESS_SYNC_SERVER_ERROR:
      return {
        kind: 'RETRYABLE',
        errorCode: BUSINESS_SYNC_ERROR.RECEIVER_UNREACHABLE,
        message: '云端业务同步暂不可达，待传任务退回待传',
      };
    case BUSINESS_SYNC_CALL_FAILURE_CODES.BUSINESS_SYNC_REJECTED:
      return {
        kind: 'TERMINAL',
        errorCode: BUSINESS_SYNC_ERROR.RECEIVER_REJECTED,
        message: '云端拒绝了本次同步，任务不再重试',
      };
    case BUSINESS_SYNC_CALL_FAILURE_CODES.BUSINESS_SYNC_INVALID_RESPONSE:
    case BUSINESS_SYNC_CALL_FAILURE_CODES.BUSINESS_SYNC_INVALID_PAYLOAD:
    default:
      return {
        kind: 'TERMINAL',
        errorCode: BUSINESS_SYNC_ERROR.DISPATCH_REJECTED,
        message: '云端回包或本机载荷不合规，任务不再重试',
      };
  }
}
