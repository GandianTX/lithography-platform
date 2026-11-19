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
