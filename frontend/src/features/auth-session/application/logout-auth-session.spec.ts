// src/features/auth-session/application/logout-auth-session.spec.ts

import { describe, expect, it, vi } from 'vitest';

import {
  createClearSessionAfterPasswordChangeUsecase,
  createConditionalLogoutAuthSessionUsecase,
  createLogoutAuthSessionUsecase,
} from './logout-auth-session';

describe('logout auth session usecase', () => {
  it('clears the single session owner and the GraphQL cache', async () => {
    const clearSession = vi.fn();
    const clearCache = vi.fn().mockResolvedValue(undefined);
    const logoutAuthSession = createLogoutAuthSessionUsecase({
      cache: { clearCache },
      session: { clearSession },
    });

    await logoutAuthSession();

    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(clearCache).toHaveBeenCalledTimes(1);
  });

  it('clears the session before awaiting the cache reset', async () => {
    const callOrder: string[] = [];
    const logoutAuthSession = createLogoutAuthSessionUsecase({
      cache: {
        clearCache: async () => {
          callOrder.push('cache');
        },
      },
      session: {
        clearSession: () => {
          callOrder.push('session');
        },
      },
    });

    await logoutAuthSession();

    expect(callOrder).toEqual(['session', 'cache']);
  });

  it('still clears the session when the cache reset rejects and propagates the error', async () => {
    const clearSession = vi.fn();
    const clearCache = vi.fn().mockRejectedValue(new Error('cache reset failed'));
    const logoutAuthSession = createLogoutAuthSessionUsecase({
      cache: { clearCache },
      session: { clearSession },
    });

    await expect(logoutAuthSession()).rejects.toThrow('cache reset failed');
    expect(clearSession).toHaveBeenCalledTimes(1);
  });

  it('runs every concurrent call through both ports exactly once', async () => {
    const clearSession = vi.fn();
    const clearCache = vi.fn().mockResolvedValue(undefined);
    const logoutAuthSession = createLogoutAuthSessionUsecase({
      cache: { clearCache },
      session: { clearSession },
    });

    await Promise.all([logoutAuthSession(), logoutAuthSession()]);

    expect(clearSession).toHaveBeenCalledTimes(2);
    expect(clearCache).toHaveBeenCalledTimes(2);
  });
});

describe('conditional logout usecase（迟到响应裁决）', () => {
  const IDENTITY = { accountId: 900201, epoch: 1 };

  it('身份匹配时清理会话真源与缓存并返回 true', async () => {
    const callOrder: string[] = [];
    const logoutIfMatches = createConditionalLogoutAuthSessionUsecase({
      cache: {
        clearCache: async () => {
          callOrder.push('cache');
        },
      },
      session: {
        clearSessionIfIdentityMatches: (identity) => {
          expect(identity).toEqual(IDENTITY);
          callOrder.push('session');

          return true;
        },
      },
    });

    await expect(logoutIfMatches(IDENTITY)).resolves.toBe(true);
    expect(callOrder).toEqual(['session', 'cache']);
  });

  it('身份不匹配（退出重登 / 已切换账号的迟到响应）时不做任何清理并返回 false', async () => {
    const clearSessionIfIdentityMatches = vi.fn().mockReturnValue(false);
    const clearCache = vi.fn().mockResolvedValue(undefined);
    const logoutIfMatches = createConditionalLogoutAuthSessionUsecase({
      cache: { clearCache },
      session: { clearSessionIfIdentityMatches },
    });

    await expect(logoutIfMatches(IDENTITY)).resolves.toBe(false);
    expect(clearSessionIfIdentityMatches).toHaveBeenCalledTimes(1);
    expect(clearCache).not.toHaveBeenCalled();
  });

  it('null 身份（装配层未接入采样）fail-closed：不清理、不触碰缓存', async () => {
    const clearSessionIfIdentityMatches = vi.fn().mockReturnValue(false);
    const clearCache = vi.fn().mockResolvedValue(undefined);
    const logoutIfMatches = createConditionalLogoutAuthSessionUsecase({
      cache: { clearCache },
      session: { clearSessionIfIdentityMatches },
    });

    await expect(logoutIfMatches(null)).resolves.toBe(false);
    expect(clearCache).not.toHaveBeenCalled();
  });

  it('身份匹配但缓存清理失败：会话已清理，错误向外传播（调用方决定是否继续跳转）', async () => {
    const clearSessionIfIdentityMatches = vi.fn().mockReturnValue(true);
    const logoutIfMatches = createConditionalLogoutAuthSessionUsecase({
      cache: { clearCache: vi.fn().mockRejectedValue(new Error('cache reset failed')) },
      session: { clearSessionIfIdentityMatches },
    });

    await expect(logoutIfMatches(IDENTITY)).rejects.toThrow('cache reset failed');
    expect(clearSessionIfIdentityMatches).toHaveBeenCalledTimes(1);
  });
});

describe('clearSessionAfterPasswordChange usecase（改密后会话收口）', () => {
  const IDENTITY = { accountId: 900201, epoch: 1 };

  it('身份匹配时清理会话与缓存并返回 true', async () => {
    const clearSessionIfIdentityMatches = vi.fn().mockReturnValue(true);
    const clearCache = vi.fn().mockResolvedValue(undefined);
    const clearSession = createClearSessionAfterPasswordChangeUsecase({
      cache: { clearCache },
      session: { clearSessionIfIdentityMatches },
    });

    await expect(clearSession(IDENTITY)).resolves.toBe(true);
    expect(clearSessionIfIdentityMatches).toHaveBeenCalledWith(IDENTITY);
    expect(clearCache).toHaveBeenCalledTimes(1);
  });

  it('身份不匹配（退出重登 / 已切换账号的迟到响应）返回 false 且不触碰缓存', async () => {
    const clearSessionIfIdentityMatches = vi.fn().mockReturnValue(false);
    const clearCache = vi.fn().mockResolvedValue(undefined);
    const clearSession = createClearSessionAfterPasswordChangeUsecase({
      cache: { clearCache },
      session: { clearSessionIfIdentityMatches },
    });

    await expect(clearSession(IDENTITY)).resolves.toBe(false);
    expect(clearCache).not.toHaveBeenCalled();
  });

  it('缓存清理失败不向外传播：会话已清理，返回 true 让调用方继续跳转（与 LogoutButton 同一口径）', async () => {
    const clearSessionIfIdentityMatches = vi.fn().mockReturnValue(true);
    const clearSession = createClearSessionAfterPasswordChangeUsecase({
      cache: { clearCache: vi.fn().mockRejectedValue(new Error('cache reset failed')) },
      session: { clearSessionIfIdentityMatches },
    });

    await expect(clearSession(IDENTITY)).resolves.toBe(true);
    expect(clearSessionIfIdentityMatches).toHaveBeenCalledTimes(1);
  });
});
