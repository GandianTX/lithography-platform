// src/features/ai-conversation/application/ai-conversation-error.spec.ts
// 任务05：会话创建失败的性质边界
//
// 只有能证明「写入前被拒绝」的响应才算明确拒绝：
// - 认证层拒绝（`type === 'auth'`）：共享层把含 `UNAUTHENTICATED` 分类码的错误体
//   与 HTTP 401 都归一为 `auth`，后端这两类都发生在守卫阶段（早于用例与事务）；
// - 业务写前拒绝（`type === 'graphql'` 且 `extensions.code` 属白名单）。
// 其余（内部错误、混合错误、分类码缺失、传输层错误）一律按结果未知处理——
// 服务端可能已经处理或仍在处理，不能因为判断不了就重复创建会话。

import { describe, expect, it } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import { classifyAiConversationCreateFailure } from './ai-conversation-error';

describe('classifyAiConversationCreateFailure', () => {
  it('GraphQL 业务拒绝（FORBIDDEN）：写入前被拒绝，属明确拒绝', () => {
    const error = new GraphQLIngressError({
      type: 'graphql',
      message: 'FORBIDDEN',
      graphqlErrors: [
        {
          message: 'FORBIDDEN',
          extensions: {
            code: 'FORBIDDEN',
            errorCode: 'AI_CONVERSATION_FORBIDDEN',
            errorMessage: '无权访问所选工单',
          },
        },
      ],
    });

    expect(classifyAiConversationCreateFailure(error)).toBe('REJECTED');
  });

  it('入参非法（BAD_USER_INPUT）：管道／事务前校验拒绝，属明确拒绝', () => {
    const error = new GraphQLIngressError({
      type: 'graphql',
      message: 'BAD_USER_INPUT',
      graphqlErrors: [{ message: 'BAD_USER_INPUT', extensions: { code: 'BAD_USER_INPUT' } }],
    });

    expect(classifyAiConversationCreateFailure(error)).toBe('REJECTED');
  });

  it('会话不可用（UNAUTHENTICATED）：守卫阶段拒绝，属明确拒绝', () => {
    // 生产真实形态：共享层把含 UNAUTHENTICATED 分类码的错误体归一为 type='auth'
    const error = new GraphQLIngressError({
      type: 'auth',
      message: 'JWT 认证失败',
      graphqlErrors: [{ message: 'UNAUTHENTICATED', extensions: { code: 'UNAUTHENTICATED' } }],
    });

    expect(classifyAiConversationCreateFailure(error)).toBe('REJECTED');
  });

  it('会话不可用（UNAUTHENTICATED）：防御性分支同样按明确拒绝处理', () => {
    // 共享层不会产出这一形态（会归为 auth），保留以防归一规则变化后误判为未知
    const error = new GraphQLIngressError({
      type: 'graphql',
      message: 'UNAUTHENTICATED',
      graphqlErrors: [{ message: 'UNAUTHENTICATED', extensions: { code: 'UNAUTHENTICATED' } }],
    });

    expect(classifyAiConversationCreateFailure(error)).toBe('REJECTED');
  });

  it('传输层 401（无 GraphQL 错误体）：请求未进入业务逻辑，属明确拒绝', () => {
    const error = new GraphQLIngressError({
      type: 'auth',
      message: '未登录',
      statusCode: 401,
    });

    expect(classifyAiConversationCreateFailure(error)).toBe('REJECTED');
  });

  it('认证错误与执行错误混合：只要有一条不能证明写入前拒绝，整体按未知处理', () => {
    const error = new GraphQLIngressError({
      type: 'auth',
      message: 'mixed',
      graphqlErrors: [
        { message: 'UNAUTHENTICATED', extensions: { code: 'UNAUTHENTICATED' } },
        { message: 'Internal Server Error', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
      ],
    });

    expect(classifyAiConversationCreateFailure(error)).toBe('UNKNOWN');
  });

  it('内部错误（INTERNAL_SERVER_ERROR）：可能写失败回滚，也可能是 COMMIT 失败，按未知处理', () => {
    const error = new GraphQLIngressError({
      type: 'graphql',
      message: 'Internal Server Error',
      graphqlErrors: [
        { message: 'Internal Server Error', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
      ],
    });

    expect(classifyAiConversationCreateFailure(error)).toBe('UNKNOWN');
  });

  it('业务冲突（CONFLICT）：写入前性质依赖具体用例实现，按未知处理', () => {
    const error = new GraphQLIngressError({
      type: 'graphql',
      message: 'CONFLICT',
      graphqlErrors: [{ message: 'CONFLICT', extensions: { code: 'CONFLICT' } }],
    });

    expect(classifyAiConversationCreateFailure(error)).toBe('UNKNOWN');
  });

  it('混合错误：只要有一条不能证明写入前拒绝，整体按未知处理', () => {
    const error = new GraphQLIngressError({
      type: 'graphql',
      message: 'mixed',
      graphqlErrors: [
        { message: 'FORBIDDEN', extensions: { code: 'FORBIDDEN' } },
        { message: 'Internal Server Error', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
      ],
    });

    expect(classifyAiConversationCreateFailure(error)).toBe('UNKNOWN');
  });

  it('分类码缺失：无法证明写入前拒绝，按未知处理', () => {
    const error = new GraphQLIngressError({
      type: 'graphql',
      message: 'no code',
      graphqlErrors: [{ message: 'no code', extensions: {} }],
    });

    expect(classifyAiConversationCreateFailure(error)).toBe('UNKNOWN');
  });

  it('网络中断、HTTP 异常与响应不可解析：按未知处理', () => {
    expect(
      classifyAiConversationCreateFailure(
        new GraphQLIngressError({ type: 'network', message: 'Network error' }),
      ),
    ).toBe('UNKNOWN');
    expect(
      classifyAiConversationCreateFailure(
        new GraphQLIngressError({ type: 'http', message: 'Internal Server Error' }),
      ),
    ).toBe('UNKNOWN');
    expect(
      classifyAiConversationCreateFailure(
        new GraphQLIngressError({ type: 'malformed', message: 'Invalid response' }),
      ),
    ).toBe('UNKNOWN');
  });

  it('非 GraphQL 异常：按未知处理（宁可要求确认，也不重复创建）', () => {
    expect(classifyAiConversationCreateFailure(new Error('timeout'))).toBe('UNKNOWN');
    expect(classifyAiConversationCreateFailure(undefined)).toBe('UNKNOWN');
  });
});
