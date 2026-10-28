// src/shared/http/rest-request.ts

import { getGraphQLRuntimeConfig } from '@/shared/graphql';

/** REST 请求初始化（Token 头由 fetchRestWithAuthRetry 统一注入） */
export type RestRequestInit = { method?: string; body?: BodyInit };

function readAccessToken(): string | null {
  const token = getGraphQLRuntimeConfig().getAccessToken?.();

  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * 带会话失效处理的 REST 请求：401 时与 GraphQL executeGraphQL 同口径
 * （refreshSession 刷新后重试一次；无刷新能力 / 刷新失败 / 重试仍 401 时
 * 调 onAuthFailure 宣布会话失效），避免 Token 过期后请求只弹通用错误
 * 而不跳登录页的体验断链。FormData / URLSearchParams 可重复传入 fetch，重试无需重建。
 *
 * 通用技术底座（shared 可承载「通用鉴权 header 注入、通用重试」）：
 * 不带业务语义；业务错误码映射留在各 feature/infrastructure。
 * 会话边界依据：docs/project-convention/graphql-ingress-auth-boundary.md。
 */
export async function fetchRestWithAuthRetry(
  url: string,
  init: RestRequestInit,
): Promise<Response> {
  const send = (token: string | null) =>
    fetch(url, {
      ...init,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });

  let response = await send(readAccessToken());

  if (response.status !== 401) {
    return response;
  }

  const { refreshSession, onAuthFailure } = getGraphQLRuntimeConfig();

  if (!refreshSession) {
    // 没有刷新能力时（如当前 P0 登录链路），仍要宣布一次会话失效，
    // 由 app 装配决定清理与跳转（与 GraphQL 链路同口径）
    onAuthFailure?.();

    return response;
  }

  try {
    await refreshSession();
  } catch {
    onAuthFailure?.();

    return response;
  }

  response = await send(readAccessToken());

  if (response.status === 401) {
    onAuthFailure?.();
  }

  return response;
}
