// src/features/auth-session/infrastructure/auth-return-to-url.ts

// 认证链路 URL 参数适配的唯一收口：returnTo 读取、登录跳转 query 编码、
// 请求目标拼接与 pathname 解析都属于技术格式适配，见 docs/infrastructure-rules.md。
// application 只决定是否接受目标路径以及跳往哪里。
export const AUTH_RETURN_TO_PARAM_KEY = 'returnTo';

// 失效原因的受控词表：目前仅 session-expired 一种。应用内部只由 GraphQL
// UNAUTHENTICATED 链路生成该参数；登录页只识别固定白名单值。后端原始
// message、errorCode、Token 不进入 URL。
export const AUTH_LOGIN_REASON_PARAM_KEY = 'reason';
export const AUTH_LOGIN_REASON_SESSION_EXPIRED = 'session-expired';

export function readAuthReturnToParam(searchParams: URLSearchParams): string | null {
  return searchParams.get(AUTH_RETURN_TO_PARAM_KEY);
}

export function readAuthLoginReasonParam(searchParams: URLSearchParams): string | null {
  return searchParams.get(AUTH_LOGIN_REASON_PARAM_KEY);
}

export function readAuthReturnToFromRequest(request: Request): string | null {
  return readAuthReturnToParam(new URL(request.url).searchParams);
}

export function composeProtectedRequestTarget(request: Request): string {
  const requestUrl = new URL(request.url);

  return requestUrl.pathname + requestUrl.search;
}

export function composeLoginRedirectPath(requestedPath: string, reason?: string): string {
  const reasonParam = reason ? `${AUTH_LOGIN_REASON_PARAM_KEY}=${encodeURIComponent(reason)}&` : '';

  return `/login?${reasonParam}${AUTH_RETURN_TO_PARAM_KEY}=${encodeURIComponent(requestedPath)}`;
}

// 失效跳转的唯一 URL 合成：恒定携带固定失效原因；没有安全站内路径时
// 只带原因，不带 returnTo（如当前已在 /login，避免循环）。
// 带 returnTo 的分支委托 composeLoginRedirectPath，避免第二份 URL 编码实现。
export function composeSessionExpiredLoginRedirectPath(requestedPath: string | null): string {
  if (requestedPath === null) {
    return `/login?${AUTH_LOGIN_REASON_PARAM_KEY}=${encodeURIComponent(AUTH_LOGIN_REASON_SESSION_EXPIRED)}`;
  }

  return composeLoginRedirectPath(requestedPath, AUTH_LOGIN_REASON_SESSION_EXPIRED);
}

/**
 * 启动恢复无法确认会话时的落点（网络/服务故障，不是未登录）。
 *
 * 与登录页区分开：这里保留 returnTo 与重试入口，不清会话、不要求重新输入凭据。
 */
export const SESSION_UNAVAILABLE_PATH = '/session-unavailable';

export function composeSessionUnavailableRedirectPath(requestedPath: string | null): string {
  if (!requestedPath) {
    return SESSION_UNAVAILABLE_PATH;
  }

  return `${SESSION_UNAVAILABLE_PATH}?${AUTH_RETURN_TO_PARAM_KEY}=${encodeURIComponent(requestedPath)}`;
}

export function extractUrlPathname(value: string): string {
  try {
    return new URL(value, 'https://lithography.local').pathname;
  } catch {
    return value;
  }
}
