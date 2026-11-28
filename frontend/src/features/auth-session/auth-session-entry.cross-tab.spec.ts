// src/features/auth-session/auth-session-entry.cross-tab.spec.ts

// D1 回归：本页还没有会话（启动恢复在途）时收到跨页事件，事件之前发起的恢复必须失效。
// 反例要点：旧响应（成功 / 401 / 网络失败）不得建立会话、不得清别人的会话与缓存，
// 也不得把页面导向重试页；换号后如需恢复，必须用当前 Cookie 重新发请求。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RestoreWebSessionResult } from './infrastructure/auth-web-session-rest';

vi.mock('@/shared/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/env')>();

  return { ...actual, isWebSessionEnabled: () => true };
});

vi.mock('./infrastructure/auth-web-session-rest', () => ({
  restWebSessionGateway: { restore: vi.fn(), revoke: vi.fn() },
}));

vi.mock('./infrastructure/auth-login-rest', () => ({
  restAuthLoginGateway: { loginWithPassword: vi.fn() },
}));

vi.mock('./infrastructure/apollo-session-cache', () => ({
  apolloAuthSessionCache: { clearCache: vi.fn() },
}));

import { authSessionChannel } from './application/auth-session-channel';
import { apolloAuthSessionCache } from './infrastructure/apollo-session-cache';
import { restAuthLoginGateway } from './infrastructure/auth-login-rest';
import { restWebSessionGateway } from './infrastructure/auth-web-session-rest';
import {
  applyCrossTabSessionEvent,
  authSessionStore,
  ensureWebSessionRestored,
  getCurrentAuthSession,
  loginWithPassword,
  logoutAuthSessionWithSignOut,
  restoreController,
} from './auth-session-entry';

const STORAGE_KEY = 'lithography-platform.auth-session.v1';
const restoreMock = vi.mocked(restWebSessionGateway.restore);
const revokeMock = vi.mocked(restWebSessionGateway.revoke);
const restLoginMock = vi.mocked(restAuthLoginGateway.loginWithPassword);
const clearCacheMock = vi.mocked(apolloAuthSessionCache.clearCache);

function snapshot(accountId: number, nickname: string) {
  return {
    accessToken: `token-${accountId}`,
    accountId,
    adminLevel: null,
    customerOrganizationId: null,
    engineerOrganizationId: null,
    adminOrganizationId: null,
    registrationOrganizationId: null,
    restriction: 'NONE' as const,
    role: 'CUSTOMER' as const,
    userInfo: { accessGroup: ['CUSTOMER'] as const, avatarUrl: null, nickname },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, reject, resolve };
}

describe('跨页事件与在途恢复（本页尚无会话）', () => {
  beforeEach(() => {
    restoreMock.mockReset();
    revokeMock.mockReset();
    restLoginMock.mockReset();
    clearCacheMock.mockReset();
    window.sessionStorage.clear();
    authSessionStore.clearSession();
    // 控制器是模块级单例：每个用例从「无记忆、无在途」开始
    restoreController.invalidatePendingRestore();
  });

  afterEach(() => {
    window.sessionStorage.clear();
    authSessionStore.clearSession();
    restoreController.invalidatePendingRestore();
  });

  it('退出事件后，旧的成功响应不得把本页登回去', async () => {
    const pending = deferred<RestoreWebSessionResult>();
    restoreMock.mockReturnValue(pending.promise);

    const inFlight = ensureWebSessionRestored();
    await applyCrossTabSessionEvent({ type: 'logout' });
    pending.resolve({ status: 'restored', session: snapshot(900101, 'A1') });

    await expect(inFlight).resolves.toBe('stale');
    expect(getCurrentAuthSession()).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('换号事件后，旧响应作废；需要恢复时用当前 Cookie 重新发请求', async () => {
    const pending = deferred<RestoreWebSessionResult>();
    restoreMock.mockReturnValueOnce(pending.promise);
    restoreMock.mockResolvedValueOnce({ status: 'restored', session: snapshot(900202, 'A2') });

    const inFlight = ensureWebSessionRestored();
    await applyCrossTabSessionEvent({ type: 'session-replaced', accountId: 900202 });
    pending.resolve({ status: 'restored', session: snapshot(900101, 'A1') });

    await expect(inFlight).resolves.toBe('stale');
    expect(getCurrentAuthSession()).toBeNull();

    await expect(ensureWebSessionRestored()).resolves.toBe('restored');
    expect(getCurrentAuthSession()?.accountId).toBe(900202);
    expect(restoreMock).toHaveBeenCalledTimes(2);
  });

  it('旧的 401（明确无会话）晚到，不得清掉期间建立的新会话', async () => {
    const pending = deferred<RestoreWebSessionResult>();
    restoreMock.mockReturnValue(pending.promise);

    const inFlight = ensureWebSessionRestored();
    await applyCrossTabSessionEvent({ type: 'session-replaced', accountId: 900202 });
    authSessionStore.establishSession(snapshot(900202, 'A2'));
    pending.resolve({ status: 'absent' });

    await expect(inFlight).resolves.toBe('stale');
    expect(getCurrentAuthSession()?.accountId).toBe(900202);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('旧的网络失败晚到，按 stale 处理而不是进重试页', async () => {
    const pending = deferred<RestoreWebSessionResult>();
    restoreMock.mockReturnValue(pending.promise);

    const inFlight = ensureWebSessionRestored();
    await applyCrossTabSessionEvent({ type: 'logout' });
    pending.reject(new Error('network down'));

    await expect(inFlight).resolves.toBe('stale');
  });

  it('旧请求收尾不影响期间新发起的恢复', async () => {
    const oldPending = deferred<RestoreWebSessionResult>();
    const newPending = deferred<RestoreWebSessionResult>();
    restoreMock.mockReturnValueOnce(oldPending.promise).mockReturnValueOnce(newPending.promise);

    const oldAttempt = ensureWebSessionRestored();
    await applyCrossTabSessionEvent({ type: 'session-replaced', accountId: 900202 });

    const newAttempt = ensureWebSessionRestored();
    expect(newAttempt).not.toBe(oldAttempt);

    oldPending.resolve({ status: 'restored', session: snapshot(900101, 'A1') });
    await expect(oldAttempt).resolves.toBe('stale');

    // 旧请求结束后，进行中的新请求仍是共享的那一个
    expect(ensureWebSessionRestored()).toBe(newAttempt);

    newPending.resolve({ status: 'restored', session: snapshot(900202, 'A2') });
    await expect(newAttempt).resolves.toBe('restored');
    expect(getCurrentAuthSession()?.accountId).toBe(900202);
  });

  it('已有会话时收到换号事件仍按既有行为清理并返回 true', async () => {
    authSessionStore.establishSession(snapshot(900101, 'A1'));

    await expect(
      applyCrossTabSessionEvent({ type: 'session-replaced', accountId: 900202 }),
    ).resolves.toBe(true);
    expect(getCurrentAuthSession()).toBeNull();
  });

  it('登录成功后向其他标签页发布换号事件（开启态同步行为保留）', async () => {
    restLoginMock.mockResolvedValue(snapshot(900202, 'A2'));
    const publishSpy = vi.spyOn(authSessionChannel, 'publish');

    const view = await loginWithPassword({ loginName: 'a2', loginPassword: 'pw' });

    expect(view.accountId).toBe(900202);
    expect(publishSpy).toHaveBeenCalledWith({ type: 'session-replaced', accountId: 900202 });
    publishSpy.mockRestore();
  });

  it('退出成功后向其他标签页发布退出事件并清缓存（开启态同步行为保留）', async () => {
    authSessionStore.establishSession(snapshot(900101, 'A1'));
    revokeMock.mockResolvedValue('ok');
    const publishSpy = vi.spyOn(authSessionChannel, 'publish');

    await expect(logoutAuthSessionWithSignOut()).resolves.toBe('ok');

    expect(publishSpy).toHaveBeenCalledWith({ type: 'logout' });
    expect(clearCacheMock).toHaveBeenCalled();
    expect(getCurrentAuthSession()).toBeNull();
    publishSpy.mockRestore();
  });
});
