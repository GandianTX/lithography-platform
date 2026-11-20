// src/features/ai-conversation/application/ai-conversation-error.ts
// GraphQL 失败描述归一：只把可展示的原因交给界面，不泄露内部堆栈。

import type { GraphQLIngressError } from '@/shared/graphql';
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
 * - `REJECTED`：服务端在**写入之前**就拒绝了请求，会话确定**没有**创建
 *   → 保留草稿与工单选择，用户可改选择后重试；
 * - `UNKNOWN`：无法证明请求在写入前被拒绝（服务端可能已经处理，或仍在处理）
 *   → 结果未知，必须阻止隐式重复创建，交由用户显式确认后再继续。
 */
export type AiConversationCreateFailure = 'REJECTED' | 'UNKNOWN';

/**
 * 能证明「写入前被拒绝」的稳定 GraphQL 分类。
 *
 * 依据 `backend/docs/api/graphql-error-contract-current.md` 与后端异常过滤器的映射：
 * - `UNAUTHENTICATED`：当前会话不可用，由请求守卫在进入业务逻辑前拒绝；
 * - `FORBIDDEN`：已认证用户的权限不足，由守卫或用例的**写入前**授权校验拒绝；
 * - `BAD_USER_INPUT`：入参非法，由管道校验或用例的**事务开启前**参数校验拒绝。
 *
 * 这三类都发生在任何会话记录写入之前，可证明本次创建没有落地。
 *
 * 明确**不**包含 `INTERNAL_SERVER_ERROR`：后端把「写入失败并回滚」与
 * 「COMMIT 阶段失败（结果未知）」映射到同一分类，前端无法据此区分；
 * 也**不**包含 `CONFLICT` / `NOT_FOUND` 等业务拒绝——它们的写入前性质依赖具体
 * 用例实现，无法仅凭公共分类稳定断言。
 */
const PRE_WRITE_REJECTION_CODES: ReadonlySet<string> = new Set([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'BAD_USER_INPUT',
]);

/** 读取全部 GraphQL 错误的公共分类码（缺失或非字符串一律记为空串 → 不可证明） */
function readGraphQLErrorCodes(error: GraphQLIngressError): readonly string[] {
  return (error.graphqlErrors ?? []).map((item) => {
    const extensions = item.extensions as Record<string, unknown> | undefined;
    const code = extensions?.['code'];
    return typeof code === 'string' ? code : '';
  });
}

/** 全部错误码都属于「写入前拒绝」时才成立（空数组不成立） */
function areAllCodesPreWriteRejection(codes: readonly string[]): boolean {
  return codes.length > 0 && codes.every((code) => PRE_WRITE_REJECTION_CODES.has(code));
}

/**
 * 判定会话创建失败的性质（只读错误边界，不做恢复动作）。
 *
 * 依据共享层的 `GraphQLIngressError`：
 * - `type === 'auth'`：认证层拒绝。共享层（`shared/graphql/errors.ts`）会把含
 *   `UNAUTHENTICATED` 分类码（或 `TOKEN_INVALID` 文本）的错误体归一为 `auth`，
 *   HTTP 401 同样归一为 `auth`。后端这两类都发生在守卫阶段——早于用例、事务与
 *   任何写入，因此**可证明本次创建没有落地**；
 * - `type === 'graphql'`：按 `extensions.code` 判定，混合错误整体按未知处理；
 * - 其余（`network` / `http` / `malformed`）与非 GraphQL 异常：拿不到可判定的
 *   错误分类，无法证明服务端是否已处理 → 结果未知。
 */
export function classifyAiConversationCreateFailure(error: unknown): AiConversationCreateFailure {
  if (!isGraphQLIngressError(error)) {
    return 'UNKNOWN';
  }
  if (error.type === 'auth') {
    const codes = readGraphQLErrorCodes(error);
    // HTTP 401 没有 GraphQL 错误体：请求未进入业务逻辑，同样可证明未写入
    return codes.length === 0 || areAllCodesPreWriteRejection(codes) ? 'REJECTED' : 'UNKNOWN';
  }
  if (error.type !== 'graphql') {
    return 'UNKNOWN';
  }
  const codes = readGraphQLErrorCodes(error);
  return areAllCodesPreWriteRejection(codes) ? 'REJECTED' : 'UNKNOWN';
}
