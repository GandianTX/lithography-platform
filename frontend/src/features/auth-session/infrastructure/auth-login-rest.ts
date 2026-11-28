// src/features/auth-session/infrastructure/auth-login-rest.ts

import { getWebSessionEndpoint } from '@/shared/env';
import { GraphQLIngressError } from '@/shared/graphql';

import type { AuthSessionSnapshot } from '../application/auth-session.types';
import type { AuthLoginGateway, LoginWithPasswordInput } from '../application/login-with-password';

import { decodeAuthSessionPayload, isRecord } from './auth-session-mapper';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 浏览器会话登录网关（同源 REST）。
 *
 * 与 GraphQL 登录网关的关系：
 * - 凭据校验、失败码、受限会话、身份/角色/组织全部由后端同一用例计算，前端只换传输通道；
 * - 返回值仍是 `AuthSessionSnapshot`，因此 application 层与路由权限逻辑零改动；
 * - 错误统一收敛为 `GraphQLIngressError`（共享 ingress 错误类型），
 *   既有 `resolveLoginErrorMessage` 的「凭据错误 / 网络错误」话术可直接复用。
 *
 * 后端响应由既有 `FormatResponseMiddleware` 包裹为 `{ success, data }`；
 * 这里对包裹与裸体都做兼容，但**不**根据 `success` 判断成败（一律以 HTTP 状态为准）。
 */
export function createRestAuthLoginGateway(fetchImpl?: FetchLike): AuthLoginGateway {
  return {
    async loginWithPassword(input: LoginWithPasswordInput): Promise<AuthSessionSnapshot> {
      const payload = await postWebSession(
        'login',
        {
          loginName: input.loginName,
          loginPassword: input.loginPassword,
        },
        fetchImpl,
      );

      const session = decodeAuthSessionPayload(payload);

      if (!session) {
        throw new GraphQLIngressError({
          type: 'malformed',
          message: 'Web session login response did not contain a valid session.',
          operationName: 'WebSessionLogin',
        });
      }

      return session;
    },
  };
}

export const restAuthLoginGateway = createRestAuthLoginGateway();

/**
 * 调用浏览器会话端点并返回解包后的 JSON 体。
 *
 * 刻意只在 401 时归一为 `auth` 类型：其余状态码都按服务异常处理，
 * 不把「配置错误 / 服务未就绪」伪装成凭据错误。
 */
export async function postWebSession(
  action: 'login' | 'restore' | 'logout',
  body: Record<string, unknown> | null,
  fetchImpl: FetchLike = defaultFetch,
): Promise<unknown> {
  let response: Response;

  try {
    response = await fetchImpl(`${getWebSessionEndpoint()}/${action}`, {
      method: 'POST',
      // 会话 Cookie 是同源 HttpOnly：必须显式携带，且不缓存响应
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new GraphQLIngressError({
      type: 'network',
      message: 'Web session request failed before reaching the server.',
      operationName: `WebSession${capitalize(action)}`,
      cause: error,
    });
  }

  if (response.status === 401) {
    throw new GraphQLIngressError({
      type: 'auth',
      statusCode: 401,
      message: 'Web session was rejected by the server.',
      operationName: `WebSession${capitalize(action)}`,
    });
  }

  if (!response.ok) {
    throw new GraphQLIngressError({
      type: 'http',
      statusCode: response.status,
      message: `Web session request failed with status ${response.status}.`,
      operationName: `WebSession${capitalize(action)}`,
    });
  }

  if (response.status === 204) {
    return null;
  }

  const raw: unknown = await response.json().catch(() => undefined);

  if (raw === undefined) {
    throw new GraphQLIngressError({
      type: 'malformed',
      message: 'Web session response was not valid JSON.',
      operationName: `WebSession${capitalize(action)}`,
    });
  }

  return unwrapRestEnvelope(raw);
}

function unwrapRestEnvelope(value: unknown): unknown {
  if (isRecord(value) && 'data' in value) {
    return value.data;
  }

  return value;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}
