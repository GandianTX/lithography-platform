// src/features/registration/application/registration-error.spec.ts

import { describe, expect, it } from 'vitest';

import { GraphQLIngressError, type GraphQLIngressErrorType } from '@/shared/graphql';

import { resolveRegistrationErrorMessage } from './registration-error';

const DEFAULT_MESSAGE = '注册失败，请稍后重试。';
const DUPLICATE_MESSAGE = '该登录邮箱或登录名已被注册，请更换后重试。';
const INVALID_INPUT_MESSAGE = '提交信息有误，请检查后重新提交。';

const CALLER_MESSAGES = {
  organizationUnavailable: '客户口径：所选公司不可用。',
  invalidCompanyInput: '客户口径：公司输入兜底。',
};

function ingressError(
  type: GraphQLIngressErrorType,
  extensions?: Record<string, unknown>,
): GraphQLIngressError {
  return new GraphQLIngressError({
    type,
    message: 'internal detail',
    ...(extensions ? { graphqlErrors: [{ message: 'internal detail', extensions }] } : {}),
  });
}

describe('resolveRegistrationErrorMessage（注册失败文案映射）', () => {
  it('非 ingress 的普通错误保留可读原文', () => {
    expect(resolveRegistrationErrorMessage(new Error('保存失败'), CALLER_MESSAGES)).toBe(
      '保存失败',
    );
  });

  it('非 ingress 且无可读消息时使用统一兜底，不展示空文案', () => {
    expect(resolveRegistrationErrorMessage(new Error('   '), CALLER_MESSAGES)).toBe(
      DEFAULT_MESSAGE,
    );
    expect(resolveRegistrationErrorMessage('unknown', CALLER_MESSAGES)).toBe(DEFAULT_MESSAGE);
  });

  it.each([
    ['network', '网络连接异常，请稍后重试。'],
    ['http', '服务暂时不可用，请稍后重试。'],
    ['malformed', '返回结果异常，请稍后重试。'],
  ] as const)('%s 传输失败使用 ingress 提供的用户文案', (type, expected) => {
    expect(resolveRegistrationErrorMessage(ingressError(type), CALLER_MESSAGES)).toBe(expected);
  });

  it('auth 类失败不把「重新登录」文案当注册失败展示，回落统一兜底', () => {
    expect(resolveRegistrationErrorMessage(ingressError('auth'), CALLER_MESSAGES)).toBe(
      DEFAULT_MESSAGE,
    );
  });

  it('GraphQL 错误没有业务细节时回落统一兜底', () => {
    expect(resolveRegistrationErrorMessage(ingressError('graphql'), CALLER_MESSAGES)).toBe(
      DEFAULT_MESSAGE,
    );
    expect(
      resolveRegistrationErrorMessage(
        ingressError('graphql', { code: 'SOMETHING_ELSE' }),
        CALLER_MESSAGES,
      ),
    ).toBe(DEFAULT_MESSAGE);
  });

  it('账号已存在使用去重文案，不依赖服务端自由文本', () => {
    expect(
      resolveRegistrationErrorMessage(
        ingressError('graphql', {
          code: 'CONFLICT',
          errorCode: 'ACCOUNT_ALREADY_EXISTS',
          errorMessage: 'raw database detail',
        }),
        CALLER_MESSAGES,
      ),
    ).toBe(DUPLICATE_MESSAGE);
  });

  it('公司不可用使用调用方提供的按注册类型文案', () => {
    expect(
      resolveRegistrationErrorMessage(
        ingressError('graphql', {
          code: 'BAD_USER_INPUT',
          errorCode: 'ACCOUNT_ORGANIZATION_NOT_AVAILABLE',
        }),
        CALLER_MESSAGES,
      ),
    ).toBe(CALLER_MESSAGES.organizationUnavailable);
  });

  it('输入归一错误优先展示服务端定位到的字段文案', () => {
    expect(
      resolveRegistrationErrorMessage(
        ingressError('graphql', {
          code: 'BAD_USER_INPUT',
          errorCode: 'INPUT_NORMALIZE_INVALID_TEXT',
          errorMessage: '昵称不符合规则',
        }),
        CALLER_MESSAGES,
      ),
    ).toBe('昵称不符合规则');
  });

  it('输入归一错误缺少字段文案时使用调用方的公司输入兜底', () => {
    expect(
      resolveRegistrationErrorMessage(
        ingressError('graphql', {
          code: 'BAD_USER_INPUT',
          errorCode: 'INPUT_NORMALIZE_REQUIRED_TEXT_EMPTY',
        }),
        CALLER_MESSAGES,
      ),
    ).toBe(CALLER_MESSAGES.invalidCompanyInput);
  });

  it('一般 BAD_USER_INPUT 优先展示字段文案，缺失时使用统一输入错误文案', () => {
    expect(
      resolveRegistrationErrorMessage(
        ingressError('graphql', {
          code: 'BAD_USER_INPUT',
          errorMessage: '登录邮箱已被占用',
        }),
        CALLER_MESSAGES,
      ),
    ).toBe('登录邮箱已被占用');
    expect(
      resolveRegistrationErrorMessage(
        ingressError('graphql', { code: 'BAD_USER_INPUT' }),
        CALLER_MESSAGES,
      ),
    ).toBe(INVALID_INPUT_MESSAGE);
  });
});
