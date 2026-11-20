// src/features/ai-conversation/application/ai-conversation-error.spec.ts
// 任务05：会话创建失败的性质边界
//
// 服务端明确答复（GraphQL 业务错误 / 鉴权失败）与会话确定未创建；
// 网络中断、HTTP 异常、响应无法解析与非 GraphQL 异常都可能已到达服务端，
// 属结果未知，必须阻止隐式重复创建。

import { describe, expect, it } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import { classifyAiConversationCreateFailure } from './ai-conversation-error';

describe('classifyAiConversationCreateFailure', () => {
  it('GraphQL 业务错误：服务端已答复，属明确拒绝', () => {
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

  it('鉴权失败：登录状态失效，属明确拒绝', () => {
    const error = new GraphQLIngressError({ type: 'auth', message: '未登录', statusCode: 401 });

    expect(classifyAiConversationCreateFailure(error)).toBe('REJECTED');
  });

  it('网络中断：请求可能已到达服务端，属结果未知', () => {
    const error = new GraphQLIngressError({ type: 'network', message: 'Network error' });

    expect(classifyAiConversationCreateFailure(error)).toBe('UNKNOWN');
  });

  it('HTTP 异常：结果未知', () => {
    const error = new GraphQLIngressError({ type: 'http', message: 'Internal Server Error' });

    expect(classifyAiConversationCreateFailure(error)).toBe('UNKNOWN');
  });

  it('响应无法解析：结果未知', () => {
    const error = new GraphQLIngressError({ type: 'malformed', message: 'Invalid response' });

    expect(classifyAiConversationCreateFailure(error)).toBe('UNKNOWN');
  });

  it('非 GraphQL 异常：按结果未知处理（宁可要求核对，也不重复创建）', () => {
    expect(classifyAiConversationCreateFailure(new Error('timeout'))).toBe('UNKNOWN');
    expect(classifyAiConversationCreateFailure(undefined)).toBe('UNKNOWN');
  });
});
