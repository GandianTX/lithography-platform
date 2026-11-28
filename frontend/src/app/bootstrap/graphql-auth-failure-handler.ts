// src/app/bootstrap/graphql-auth-failure-handler.ts

export type GraphQLAuthFailureDependencies = {
  getCurrentPath: () => string | null;
  /**
   * 读取当前会话令牌（不参与展示）。
   *
   * 用于忽略「旧会话的迟到 401」：切换账号 / 退出重登后，旧请求的失败必须静默，
   * 不能清理新会话、也不能清除浏览器里的新 Cookie。
   */
  getCurrentAccessToken?: () => string | null;
  hasAuthSession: () => boolean;
  /**
   * **仅本地**清理（会话真源 + GraphQL 缓存）。
   *
   * 刻意不接服务端 sign-out：业务请求的 401 只代表「这个令牌失效」，
   * 不代表浏览器当前 Cookie 也应被清掉——否则旧请求的迟到响应可能误清新会话。
   * 服务端 Cookie 由主动退出（`logoutAuthSession`）或自然过期清除。
   */
  clearAuthSessionLocally: () => Promise<unknown>;
  navigateToLogin: (targetPath: string) => void;
  resolveSessionExpiredLoginPath: (currentPath: string | null) => string;
};

// 并发受保护请求可能同时收到 UNAUTHENTICATED。这个应用级 handler
// 负责把一次失效周期收敛为一次清理和一次导航；跳转目标由 auth-session
// 策略合成（固定失效原因 + 安全 returnTo），handler 不接触后端原始错误。
export function createGraphQLAuthFailureHandler({
  getCurrentPath,
  getCurrentAccessToken,
  hasAuthSession,
  clearAuthSessionLocally,
  navigateToLogin,
  resolveSessionExpiredLoginPath,
}: GraphQLAuthFailureDependencies) {
  let isHandlingAuthFailure = false;

  return function handleGraphQLAuthFailure(info?: { accessToken?: string | null }) {
    if (isHandlingAuthFailure) {
      return;
    }

    // 只有存在会话时的 UNAUTHENTICATED 才构成失效周期；会话已被清理后的
    // 残余失败请求不再重复清理与跳转，避免重复提示或重复跳转。
    if (!hasAuthSession()) {
      return;
    }

    // 迟到失败：令牌已不是当前会话使用的令牌（切换账号 / 退出重登）→ 完全静默
    if (info && 'accessToken' in info) {
      const attemptedToken = info.accessToken ?? null;

      if (attemptedToken === null || attemptedToken !== getCurrentAccessToken?.()) {
        return;
      }
    }

    isHandlingAuthFailure = true;

    // 在清理前取得当前页面路径，保证 returnTo 反映失效前的站内页面。
    const currentPath = getCurrentPath();

    void (async () => {
      try {
        await clearAuthSessionLocally();
      } catch {
        // 清理失败不能阻断安全回退；仍然返回登录页。
      } finally {
        // 携带固定失效原因与安全 returnTo 跳转；即使清理失败也必跳转。
        navigateToLogin(resolveSessionExpiredLoginPath(currentPath));
        isHandlingAuthFailure = false;
      }
    })();
  };
}
