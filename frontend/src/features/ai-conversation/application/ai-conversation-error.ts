// src/features/ai-conversation/application/ai-conversation-error.ts
// GraphQL 失败描述归一：只把可展示的原因交给界面，不泄露内部堆栈。

import { isGraphQLIngressError, readGraphQLErrorDetail } from '@/shared/graphql';

/** 把异常归一为可展示文案 */
export function describeAiConversationError(error: unknown): string {
  const detail = readGraphQLErrorDetail(error);
  if (detail?.errorMessage) {
    return detail.errorMessage;
  }
  if (detail?.errorCode) {
    return detail.errorCode;
  }
  if (isGraphQLIngressError(error)) {
    return error.message;
  }
  return error instanceof Error ? error.message : '请求失败，请稍后重试';
}

/**
 * 会话创建失败的性质。
 *
 * - `REJECTED`：服务端已明确答复并拒绝（GraphQL 业务错误、鉴权失败），
 *   会话确定**没有**创建 → 保留草稿与工单选择，用户可改选择后重试；
 * - `UNKNOWN`：网络中断、HTTP 异常、响应无法解析或非 GraphQL 异常，
 *   请求可能已到达服务端 → 结果未知，必须阻止隐式重复创建。
 */
export type AiConversationCreateFailure = 'REJECTED' | 'UNKNOWN';

/**
 * 判定会话创建失败的性质（只读错误边界，不做恢复动作）。
 *
 * 依据共享层的 `GraphQLIngressError.type`：
 * - `graphql`：服务端返回了 GraphQL 错误（业务拒绝、参数非法、越权）—— 明确拒绝；
 * - `auth`：登录状态失效 —— 明确拒绝；
 * - `network` / `http` / `malformed`：请求可能已到达服务端 —— 结果未知。
 *
 * 非 ingress 异常（如测试替身抛出的普通 Error）按未知处理：宁可要求用户核对，
 * 也不能因为判断不了就重复创建会话。
 */
export function classifyAiConversationCreateFailure(error: unknown): AiConversationCreateFailure {
  if (!isGraphQLIngressError(error)) {
    return 'UNKNOWN';
  }
  if (error.type === 'graphql' || error.type === 'auth') {
    return 'REJECTED';
  }
  return 'UNKNOWN';
}
