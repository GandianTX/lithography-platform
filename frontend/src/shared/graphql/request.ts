// src/shared/graphql/request.ts

import { type FetchPolicy, gql, type OperationVariables } from '@apollo/client';
import { type DocumentNode, getOperationAST, type OperationDefinitionNode } from 'graphql';

import { getAuthorizationHeader, getGraphQLClient, getGraphQLRuntimeConfig } from './client';
import { GraphQLIngressError, toGraphQLIngressError } from './errors';

export type GraphQLAuthMode = 'required' | 'none';

type ExecuteGraphQLOptions = {
  accessToken?: string;
  allowAuthRetry?: boolean;
  authMode?: GraphQLAuthMode;
  fetchPolicy?: FetchPolicy;
};

type ParsedGraphQLDocument = {
  document: DocumentNode;
  operation: OperationDefinitionNode | null;
  operationName: string | undefined;
};

const parsedDocumentCache = new Map<string, ParsedGraphQLDocument>();

function parseGraphQLDocument(query: string): ParsedGraphQLDocument {
  const cachedDocument = parsedDocumentCache.get(query);

  if (cachedDocument) {
    return cachedDocument;
  }

  const document = gql(query);
  const operation = getOperationAST(document, undefined) ?? null;
  const parsedDocument = {
    document,
    operation,
    operationName: operation?.name?.value,
  };

  parsedDocumentCache.set(query, parsedDocument);

  return parsedDocument;
}

function buildOperationContext(options: ExecuteGraphQLOptions) {
  if (options.authMode === 'none') {
    return {
      authMode: 'none' as const,
    };
  }

  const authorizationHeader = getAuthorizationHeader(options.accessToken);

  return {
    authMode: 'required' as const,
    ...(authorizationHeader ? { headers: { Authorization: authorizationHeader } } : {}),
  };
}

async function dispatchGraphQLRequest<TData, TVariables extends OperationVariables>(
  query: string,
  variables: TVariables,
  options: ExecuteGraphQLOptions,
): Promise<TData> {
  const { document, operation, operationName } = parseGraphQLDocument(query);
  const client = getGraphQLClient();
  const context = buildOperationContext(options);

  if (operation?.operation === 'mutation') {
    const result = await client.mutate<TData, TVariables>({
      context,
      fetchPolicy: 'no-cache',
      mutation: document,
      variables,
    });

    if (!result.data) {
      throw new GraphQLIngressError({
        type: 'malformed',
        message: 'GraphQL 未返回 data。',
        operationName,
      });
    }

    return result.data;
  }

  const result = await client.query<TData, TVariables>({
    context,
    fetchPolicy: options.fetchPolicy || 'no-cache',
    query: document,
    variables,
  });

  if (!result.data) {
    throw new GraphQLIngressError({
      type: 'malformed',
      message: 'GraphQL 未返回 data。',
      operationName,
    });
  }

  return result.data;
}

function tryExtractOperationName(query: string): string | undefined {
  try {
    return parseGraphQLDocument(query).operationName;
  } catch {
    return undefined;
  }
}

export async function executeGraphQL<TData, TVariables extends OperationVariables>(
  query: string,
  variables: TVariables,
  options: ExecuteGraphQLOptions = {},
): Promise<TData> {
  // 记录本次请求实际使用的令牌：失效回调携带它，装配层才能区分
  // 「当前会话失效」与「切换账号后旧请求的迟到 401」
  const attemptedAccessToken =
    options.authMode === 'none'
      ? null
      : (options.accessToken ?? getGraphQLRuntimeConfig().getAccessToken?.() ?? null);

  try {
    return await dispatchGraphQLRequest<TData, TVariables>(query, variables, options);
  } catch (error) {
    const ingressError = toGraphQLIngressError(error, {
      operationName: tryExtractOperationName(query),
    });

    if (
      ingressError.type !== 'auth' ||
      options.authMode === 'none' ||
      options.allowAuthRetry === false
    ) {
      throw ingressError;
    }

    const { refreshSession, onAuthFailure } = getGraphQLRuntimeConfig();

    if (!refreshSession) {
      // 没有刷新能力时（如当前 P0 登录链路），仍要宣布一次会话失效，
      // 由 app 装配决定清理与跳转，见 docs/project-convention/graphql-ingress-auth-boundary.md。
      onAuthFailure?.({ accessToken: attemptedAccessToken });
      throw ingressError;
    }

    try {
      await refreshSession();
    } catch {
      onAuthFailure?.({ accessToken: attemptedAccessToken });
      throw ingressError;
    }

    const retryOptions = { ...options, accessToken: undefined };

    try {
      return await dispatchGraphQLRequest<TData, TVariables>(query, variables, retryOptions);
    } catch (retryError) {
      const retryIngressError = toGraphQLIngressError(retryError, {
        operationName: ingressError.operationName,
      });

      if (retryIngressError.type === 'auth') {
        // 重试使用的是刷新后的新令牌，不携带旧令牌信息（保持既有语义）
        onAuthFailure?.();
      }

      throw retryIngressError;
    }
  }
}
