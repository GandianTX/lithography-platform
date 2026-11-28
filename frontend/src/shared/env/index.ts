// src/shared/env/index.ts

export type AppEnv = 'dev' | 'test' | 'prod';

export function getAppEnv(): AppEnv {
  const configuredAppEnv = import.meta.env.VITE_APP_ENV;

  if (configuredAppEnv === 'dev' || configuredAppEnv === 'test' || configuredAppEnv === 'prod') {
    return configuredAppEnv;
  }

  return import.meta.env.DEV ? 'dev' : 'prod';
}

export function getGraphQLEndpoint() {
  const endpoint = import.meta.env.VITE_GRAPHQL_ENDPOINT;

  return typeof endpoint === 'string' && endpoint.trim() ? endpoint : '/graphql';
}

export function getHealthEndpoint() {
  const endpoint = import.meta.env.VITE_API_HEALTH_ENDPOINT;

  return typeof endpoint === 'string' && endpoint.trim() ? endpoint : null;
}

/**
 * 浏览器会话（网页登录保持）功能开关。
 *
 * 必须与后端 `WEB_SESSION_ENABLED` 成对切换：
 * - 关闭（默认）：登录仍走既有 GraphQL 入口，行为与改造前完全一致；
 * - 开启：登录/恢复/退出走同源 `/api/auth/web-session/*`。
 * 前后端不一致不做自动降级（不静默回退成两套凭据判断），由登录/恢复失败显式暴露。
 */
export function isWebSessionEnabled(): boolean {
  return import.meta.env.VITE_WEB_SESSION_ENABLED === 'true';
}

/**
 * 浏览器会话端点（同源相对路径，与既有 `/api/*` REST 前缀一致）。
 *
 * 相对路径是刻意选择：Cookie 的 Path 也是该路径，只有这些入口会收到 Cookie。
 */
export function getWebSessionEndpoint(): string {
  return '/api/auth/web-session';
}
