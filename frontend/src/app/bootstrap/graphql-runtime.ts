// src/app/bootstrap/graphql-runtime.ts

import { getCurrentAppRouterPath, navigateToLogin } from '@/app/router';

import {
  clearAuthSessionLocally,
  getAuthSessionAccessToken,
  hasCurrentAuthSession,
  resolveSessionExpiredLoginPath,
} from '@/features/auth-session';

import { configureGraphQLRuntime } from '@/shared/graphql';

import { createGraphQLAuthFailureHandler } from './graphql-auth-failure-handler';

// P0 非目标：不新建 refresh token 接口。未注入 refreshSession，受保护请求遇到 auth 错误时，
// shared/graphql 会直接调用 onAuthFailure（见 ingress auth boundary 契约）。
export function bootstrapGraphQLRuntime() {
  configureGraphQLRuntime({
    getAccessToken: getAuthSessionAccessToken,
    onAuthFailure: createGraphQLAuthFailureHandler({
      getCurrentPath: getCurrentAppRouterPath,
      // 401 只代表「这个令牌失效」：只清本地，绝不清浏览器当前 Cookie
      // （旧请求的迟到 401 不能误清新会话）
      getCurrentAccessToken: getAuthSessionAccessToken,
      hasAuthSession: hasCurrentAuthSession,
      clearAuthSessionLocally,
      navigateToLogin,
      resolveSessionExpiredLoginPath,
    }),
  });
}
