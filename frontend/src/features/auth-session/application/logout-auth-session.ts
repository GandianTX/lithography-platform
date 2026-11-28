// src/features/auth-session/application/logout-auth-session.ts

import type { AuthSessionIdentity } from './auth-session.types';

export type AuthSessionClearer = {
  clearSession: () => void;
};

export type AuthSessionCacheClearer = {
  clearCache: () => Promise<void>;
};

export type AuthSessionIdentityClearer = {
  clearSessionIfIdentityMatches: (identity: AuthSessionIdentity | null) => boolean;
};

/**
 * 服务端 sign-out（清浏览器 Cookie）的结果。
 *
 * `unsupported` 表示该部署未启用服务端会话（端点 404），不可能存在本功能下发的
 * Cookie，因此可以继续本地退出。
 */
export type AuthSessionSignOutPort = {
  revoke: () => Promise<'ok' | 'unsupported' | 'failed'>;
};

/**
 * 主动退出结果：
 * - `ok`：服务端 Cookie 已清除（或本来就没有会话），本地会话与缓存已清理
 * - `sign-out-failed`：服务端清除失败，**本地会话保持不变**，调用方必须提示并允许重试
 */
export type LogoutAuthSessionOutcome = 'ok' | 'sign-out-failed';

type LogoutAuthSessionDependencies = {
  cache: AuthSessionCacheClearer;
  session: AuthSessionClearer;
  /** 未注入时退化为纯本地清理（既有调用点 / 单元测试语义不变） */
  signOut?: AuthSessionSignOutPort;
};

type ConditionalLogoutAuthSessionDependencies = {
  cache: AuthSessionCacheClearer;
  session: AuthSessionIdentityClearer;
};

export function createLogoutAuthSessionUsecase({
  cache,
  session,
  signOut,
}: LogoutAuthSessionDependencies) {
  return async function logoutAuthSession(): Promise<LogoutAuthSessionOutcome> {
    // 顺序是安全语义的一部分：先确认服务端 Cookie 已清除，再清本地。
    // 反过来的话，清除失败会留下「本地已退出、新标签页仍能恢复」的假退出。
    if (signOut) {
      const result = await signOut.revoke();

      if (result === 'failed') {
        return 'sign-out-failed';
      }
    }

    session.clearSession();
    await cache.clearCache();

    return 'ok';
  };
}

/**
 * 条件登出：仅当 identity 仍描述「当前会话」（同账号且同会话代次）时清理会话真源
 * 与 GraphQL 缓存并返回 true。identity 为 null（装配层未接入采样）或不匹配
 * （改密响应在途期间退出重登 / 已切换账号）时不做任何清理并返回 false——
 * 迟到响应不得打断当前会话。缓存清理失败仍向外传播（会话已清理，由调用方
 * 决定是否继续跳转）。
 */
export function createConditionalLogoutAuthSessionUsecase({
  cache,
  session,
}: ConditionalLogoutAuthSessionDependencies) {
  return async function logoutAuthSessionIfIdentityMatches(
    identity: AuthSessionIdentity | null,
  ): Promise<boolean> {
    if (!session.clearSessionIfIdentityMatches(identity)) {
      return false;
    }

    await cache.clearCache();

    return true;
  };
}

/**
 * 改密成功后的会话收口（受限页与账号设置页共用）。
 *
 * 身份匹配时清理会话并返回 true；缓存清理失败不向外传播——会话真源已清理，
 * 调用方应继续跳转登录页（与 LogoutButton 同一口径）。身份不匹配返回 false，
 * 调用方必须对该次迟到响应完全静默。
 */
export function createClearSessionAfterPasswordChangeUsecase({
  cache,
  session,
}: ConditionalLogoutAuthSessionDependencies) {
  const logoutIfIdentityMatches = createConditionalLogoutAuthSessionUsecase({ cache, session });

  return async function clearSessionAfterPasswordChange(
    identity: AuthSessionIdentity | null,
  ): Promise<boolean> {
    try {
      return await logoutIfIdentityMatches(identity);
    } catch {
      return true;
    }
  };
}
