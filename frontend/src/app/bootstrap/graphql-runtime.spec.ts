// src/app/bootstrap/graphql-runtime.spec.ts

import { describe, expect, it, vi } from 'vitest';

import { resolveSessionExpiredLoginPath } from '@/features/auth-session';

import { createGraphQLAuthFailureHandler } from './graphql-auth-failure-handler';

function createHandlerStack(currentPath: string | null = '/customer/repair-requests/new') {
  const callOrder: string[] = [];
  const getCurrentPath = vi.fn(() => {
    callOrder.push('read-path');
    return currentPath;
  });
  const hasAuthSession = vi.fn().mockReturnValue(true);
  const clearAuthSessionLocally = vi.fn(async () => {
    callOrder.push('cleanup');
  });
  const getCurrentAccessToken = vi.fn<() => string | null>(() => 'current-token');
  const navigateToLogin = vi.fn();

  const handleAuthFailure = createGraphQLAuthFailureHandler({
    getCurrentPath,
    getCurrentAccessToken,
    hasAuthSession,
    clearAuthSessionLocally,
    navigateToLogin,
    // 使用生产策略合成跳转目标：固定失效原因 + 安全 returnTo。
    resolveSessionExpiredLoginPath,
  });

  return {
    callOrder,
    getCurrentPath,
    getCurrentAccessToken,
    handleAuthFailure,
    hasAuthSession,
    clearAuthSessionLocally,
    navigateToLogin,
  };
}

describe('global GraphQL auth failure handling', () => {
  it('runs one cleanup and one navigation for concurrent UNAUTHENTICATED failures', async () => {
    const stack = createHandlerStack();

    stack.handleAuthFailure();
    stack.handleAuthFailure();
    stack.handleAuthFailure();

    await vi.waitFor(() => {
      expect(stack.clearAuthSessionLocally).toHaveBeenCalledTimes(1);
    });
    expect(stack.navigateToLogin).toHaveBeenCalledTimes(1);
  });

  it('navigates with the fixed expiry reason and the safe pre-expiry returnTo', async () => {
    const stack = createHandlerStack();

    stack.handleAuthFailure();

    await vi.waitFor(() => {
      expect(stack.navigateToLogin).toHaveBeenCalledTimes(1);
    });
    expect(stack.navigateToLogin).toHaveBeenCalledWith(
      '/login?reason=session-expired&returnTo=%2Fcustomer%2Frepair-requests%2Fnew',
    );
  });

  it('reads the current path before any cleanup happens', async () => {
    const stack = createHandlerStack();

    stack.handleAuthFailure();

    await vi.waitFor(() => {
      expect(stack.navigateToLogin).toHaveBeenCalledTimes(1);
    });
    expect(stack.callOrder).toEqual(['read-path', 'cleanup']);
  });

  it('navigates only after the cleanup settles so the session is cleared first', async () => {
    let releaseCleanup: () => void = () => {};
    const stack = createHandlerStack();
    stack.clearAuthSessionLocally.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    );

    stack.handleAuthFailure();

    await vi.waitFor(() => {
      expect(stack.clearAuthSessionLocally).toHaveBeenCalledTimes(1);
    });
    expect(stack.navigateToLogin).not.toHaveBeenCalled();

    releaseCleanup();

    await vi.waitFor(() => {
      expect(stack.navigateToLogin).toHaveBeenCalledTimes(1);
    });
  });

  it('still navigates to the login page with the reason when the cleanup rejects', async () => {
    const stack = createHandlerStack();
    stack.clearAuthSessionLocally.mockRejectedValue(new Error('cache reset failed'));

    stack.handleAuthFailure();

    await vi.waitFor(() => {
      expect(stack.navigateToLogin).toHaveBeenCalledTimes(1);
    });
    expect(stack.navigateToLogin).toHaveBeenCalledWith(
      '/login?reason=session-expired&returnTo=%2Fcustomer%2Frepair-requests%2Fnew',
    );
    expect(stack.clearAuthSessionLocally).toHaveBeenCalledTimes(1);
  });

  it('does not attach a returnTo loop when the expiry happens on the login route', async () => {
    const stack = createHandlerStack('/login?returnTo=%2Fcustomer');

    stack.handleAuthFailure();

    await vi.waitFor(() => {
      expect(stack.navigateToLogin).toHaveBeenCalledTimes(1);
    });
    expect(stack.navigateToLogin).toHaveBeenCalledWith('/login?reason=session-expired');
  });

  it('ignores failures without an active session so stale requests cause no second cycle', () => {
    const stack = createHandlerStack();
    stack.hasAuthSession.mockReturnValue(false);

    stack.handleAuthFailure();

    expect(stack.clearAuthSessionLocally).not.toHaveBeenCalled();
    expect(stack.navigateToLogin).not.toHaveBeenCalled();
  });

  it('allows a fresh failure cycle after the previous one settled', async () => {
    const stack = createHandlerStack();

    stack.handleAuthFailure();

    await vi.waitFor(() => {
      expect(stack.clearAuthSessionLocally).toHaveBeenCalledTimes(1);
    });

    stack.handleAuthFailure();

    await vi.waitFor(() => {
      expect(stack.clearAuthSessionLocally).toHaveBeenCalledTimes(2);
    });
    expect(stack.navigateToLogin).toHaveBeenCalledTimes(2);
  });

  it('ignores a late 401 that belongs to an older token (account switch / re-login)', () => {
    const stack = createHandlerStack();
    stack.getCurrentAccessToken.mockReturnValue('new-session-token');

    // 旧请求使用的令牌已不是当前会话的令牌：不得清理、不得跳转
    stack.handleAuthFailure({ accessToken: 'old-session-token' });

    expect(stack.clearAuthSessionLocally).not.toHaveBeenCalled();
    expect(stack.navigateToLogin).not.toHaveBeenCalled();
  });

  it('ignores anonymous failures (no token attached to the request)', () => {
    const stack = createHandlerStack();

    stack.handleAuthFailure({ accessToken: null });

    expect(stack.clearAuthSessionLocally).not.toHaveBeenCalled();
    expect(stack.navigateToLogin).not.toHaveBeenCalled();
  });

  it('still handles the current session failure when the token matches', async () => {
    const stack = createHandlerStack();
    stack.getCurrentAccessToken.mockReturnValue('current-token');

    stack.handleAuthFailure({ accessToken: 'current-token' });

    await vi.waitFor(() => {
      expect(stack.clearAuthSessionLocally).toHaveBeenCalledTimes(1);
    });
    expect(stack.navigateToLogin).toHaveBeenCalledTimes(1);
  });
});
