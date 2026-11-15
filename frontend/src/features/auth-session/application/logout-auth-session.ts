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

type LogoutAuthSessionDependencies = {
  cache: AuthSessionCacheClearer;
  session: AuthSessionClearer;
};

type ConditionalLogoutAuthSessionDependencies = {
  cache: AuthSessionCacheClearer;
  session: AuthSessionIdentityClearer;
};

export function createLogoutAuthSessionUsecase({ cache, session }: LogoutAuthSessionDependencies) {
  return async function logoutAuthSession(): Promise<void> {
    session.clearSession();
    await cache.clearCache();
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
