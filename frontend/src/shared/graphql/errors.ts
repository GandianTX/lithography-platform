// src/shared/graphql/errors.ts

import { CombinedGraphQLErrors, ServerError, ServerParseError } from '@apollo/client/errors';
import type { GraphQLFormattedError } from 'graphql';

export type GraphQLIngressErrorType = 'network' | 'http' | 'graphql' | 'auth' | 'malformed';

type GraphQLIngressErrorContext = {
  operationName?: string;
};

const defaultUserMessages: Record<GraphQLIngressErrorType, string> = {
  network: '网络连接异常，请稍后重试。',
  http: '服务暂时不可用，请稍后重试。',
  graphql: '请求处理失败，请稍后重试。',
  auth: '登录状态已失效，请重新登录后再试。',
  malformed: '返回结果异常，请稍后重试。',
};

export class GraphQLIngressError extends Error {
  readonly type: GraphQLIngressErrorType;
  readonly statusCode?: number;
  readonly operationName?: string;
  readonly graphqlErrors?: readonly GraphQLFormattedError[];
  readonly isRetryable: boolean;
  override readonly cause?: unknown;

  constructor(options: {
    type: GraphQLIngressErrorType;
    message: string;
    statusCode?: number;
    operationName?: string;
    graphqlErrors?: readonly GraphQLFormattedError[];
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = 'GraphQLIngressError';
    this.type = options.type;
    this.statusCode = options.statusCode;
    this.operationName = options.operationName;
    this.graphqlErrors = options.graphqlErrors;
    this.cause = options.cause;
    this.isRetryable = resolveIsRetryable(options.type, options.statusCode);
  }

  get userMessage(): string {
    return defaultUserMessages[this.type];
  }
}

export function isGraphQLIngressError(error: unknown): error is GraphQLIngressError {
  return error instanceof GraphQLIngressError;
}

/**
 * 是否是"权限不足"（FORBIDDEN）。
 *
 * 为什么需要单独判定：权限不足与"请求处理失败"对用户是两件事——
 * 前者不该让用户反复重试，也不该显示成系统故障。后端把越权统一收敛为
 * 不泄露存在性的错误码，前端据此给出独立的"权限不足"提示。
 */
export function isForbiddenIngressError(error: unknown): boolean {
  if (!isGraphQLIngressError(error)) {
    return false;
  }
  const graphqlErrors = error.graphqlErrors ?? [];
  return graphqlErrors.some((graphqlError) => {
    const extensions = graphqlError.extensions as Record<string, unknown> | undefined;
    return extensions?.['code'] === 'FORBIDDEN' || graphqlError.message === 'FORBIDDEN';
  });
}

function resolveIsRetryable(type: GraphQLIngressErrorType, statusCode?: number): boolean {
  if (type === 'network') {
    return true;
  }

  if (type === 'http') {
    return typeof statusCode === 'number' && statusCode >= 500;
  }

  return false;
}

function hasUnauthenticatedCode(errors: readonly GraphQLFormattedError[]): boolean {
  return errors.some((error) => {
    const extensions = error.extensions as Record<string, unknown> | undefined;

    return (
      extensions?.code === 'UNAUTHENTICATED' ||
      error.message === 'TOKEN_INVALID' ||
      error.message === 'TOKEN_INVALID_AFTER_REFRESH'
    );
  });
}

function isNetworkLikeError(error: unknown): boolean {
  if (error instanceof TypeError) {
    const message = error.message.toLowerCase();

    return (
      message.includes('failed to fetch') ||
      message.includes('networkerror') ||
      message.includes('load failed')
    );
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }

  return false;
}

export function toGraphQLIngressError(
  error: unknown,
  context?: GraphQLIngressErrorContext,
): GraphQLIngressError {
  if (isGraphQLIngressError(error)) {
    return error;
  }

  const operationName = context?.operationName;

  if (CombinedGraphQLErrors.is(error)) {
    const graphqlErrors = error.errors;

    if (hasUnauthenticatedCode(graphqlErrors)) {
      return new GraphQLIngressError({
        type: 'auth',
        message: error.message,
        operationName,
        graphqlErrors,
        cause: error,
      });
    }

    return new GraphQLIngressError({
      type: 'graphql',
      message: error.message,
      operationName,
      graphqlErrors,
      cause: error,
    });
  }

  if (ServerError.is(error)) {
    const type: GraphQLIngressErrorType = error.statusCode === 401 ? 'auth' : 'http';

    return new GraphQLIngressError({
      type,
      message: error.message,
      statusCode: error.statusCode,
      operationName,
      cause: error,
    });
  }

  if (ServerParseError.is(error)) {
    const isHTTPError = error.statusCode < 200 || error.statusCode >= 300;

    return new GraphQLIngressError({
      type: isHTTPError ? 'http' : 'malformed',
      message: error.message,
      statusCode: error.statusCode,
      operationName,
      cause: error,
    });
  }

  if (isNetworkLikeError(error)) {
    return new GraphQLIngressError({
      type: 'network',
      message: error instanceof Error ? error.message : 'Network error',
      operationName,
      cause: error,
    });
  }

  return new GraphQLIngressError({
    type: 'graphql',
    message: error instanceof Error ? error.message : 'Unknown GraphQL execution error',
    operationName,
    cause: error,
  });
}

export type GraphQLErrorDetail = {
  /** GraphQL 大类码（extensions.code），契约保证稳定的生产分支信号 */
  code: string | null;
  /** 业务细节码（extensions.errorCode），仅调试/可观测/可选展示，生产可能隐藏 */
  errorCode: string | null;
  /** 后端业务消息（extensions.errorMessage），为空时用前端兜底文案 */
  errorMessage: string | null;
};

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 从 ingress error 中读取第一条 GraphQL 错误的业务细节。
 * 生产分支只依赖稳定的 extensions.code；不取顶层通用 message（避免把通用文案当业务消息），
 * 不做任何 Session 读写。各 feature adapter 的错误映射共用本实现，不复制第二份。
 */
export function readGraphQLErrorDetail(error: unknown): GraphQLErrorDetail | null {
  if (!isGraphQLIngressError(error) || !error.graphqlErrors?.length) {
    return null;
  }

  const [firstError] = error.graphqlErrors;
  const extensions = (firstError.extensions as Record<string, unknown> | undefined) || {};

  return {
    code: normalizeOptionalString(extensions.code),
    errorCode: normalizeOptionalString(extensions.errorCode),
    errorMessage: normalizeOptionalString(extensions.errorMessage),
  };
}
