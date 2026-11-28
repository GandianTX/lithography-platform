// src/features/auth-session/auth-session-entry.cross-tab-disabled.spec.ts

// 功能关闭（VITE_WEB_SESSION_ENABLED !== 'true'，默认状态）时的跨标签契约：
// 不建立通道、不发布事件、不处理事件；处理函数即使被直接调用，也不得清理本页
// 会话、不得改动恢复状态——保持改造前基于 sessionStorage 的标签页独立行为。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/env')>();

  return { ...actual, isWebSessionEnabled: () => false };
});

vi.mock('./infrastructure/auth-web-session-rest', () => ({
  restWebSessionGateway: { restore: vi.fn(), revoke: vi.fn() },
}));

// 功能关闭时登录网关是既有 GraphQL 入口
vi.mock('./infrastructure/auth-login-graphql', () => ({
  graphQLAuthLoginGateway: { loginWithPassword: vi.fn() },
}));

vi.mock('./infrastructure/apollo-session-cache', () => ({
  apolloAuthSessionCache: { clearCache: vi.fn() },
}));

import { authSessionChannel } from './application/auth-session-channel';
import { apolloAuthSessionCache } from './infrastructure/apollo-session-cache';
import { graphQLAuthLoginGateway } from './infrastructure/auth-login-graphql';
import {
  applyCrossTabSessionEvent,
  authSessionStore,
  ensureWebSessionRestored,
  getCurrentAuthSession,
  loginWithPassword,
  logoutAuthSessionWithSignOut,
  startAuthSessionCrossTabSync,
} from './auth-session-entry';

const STORAGE_KEY = 'lithography-platform.auth-session.v1';
const clearCacheMock = vi.mocked(apolloAuthSessionCache.clearCache);
const graphQLLoginMock = vi.mocked(graphQLAuthLoginGateway.loginWithPassword);

/** 统计构造次数的 BroadcastChannel 替身：jsdom 没有原生实现，用于断言「从未建通道」 */
class FakeBroadcastChannel {
  static constructedCount = 0;

  constructor() {
    FakeBroadcastChannel.constructedCount += 1;
  }

  postMessage(): void {}

  close(): void {}

  addEventListener(): void {}

  removeEventListener(): void {}
}

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

describe('功能关闭时跨标签同步整体失效（默认状态契约）', () => {
  beforeEach(() => {
    FakeBroadcastChannel.constructedCount = 0;
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    graphQLLoginMock.mockReset();
    clearCacheMock.mockReset();
    window.sessionStorage.clear();
    authSessionStore.clearSession();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
    authSessionStore.clearSession();
  });

  it('启动跨标签同步时不建立 BroadcastChannel、不订阅，返回可调用的取消函数', () => {
    const unsubscribe = startAuthSessionCrossTabSync();

    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
    expect(FakeBroadcastChannel.constructedCount).toBe(0);
  });

  it('登录成功不发布换号事件、不建立通道', async () => {
    graphQLLoginMock.mockResolvedValue(snapshot(900202, 'A2'));
    const publishSpy = vi.spyOn(authSessionChannel, 'publish');

    const view = await loginWithPassword({ loginName: 'a2', loginPassword: 'pw' });

    expect(view.accountId).toBe(900202);
    expect(publishSpy).not.toHaveBeenCalled();
    expect(FakeBroadcastChannel.constructedCount).toBe(0);
    publishSpy.mockRestore();
  });

  it('退出成功不发布退出事件、不建立通道', async () => {
    authSessionStore.establishSession(snapshot(900101, 'A1'));
    const publishSpy = vi.spyOn(authSessionChannel, 'publish');

    await expect(logoutAuthSessionWithSignOut()).resolves.toBe('ok');

    expect(publishSpy).not.toHaveBeenCalled();
    expect(FakeBroadcastChannel.constructedCount).toBe(0);
    publishSpy.mockRestore();
  });

  it('两个标签页互不影响：A 登录另一账号或退出后，B 的会话保持', async () => {
    // B 标签页先建立会话（真实 sessionStorage 独立于其他标签页）
    authSessionStore.establishSession(snapshot(900101, 'A1'));
    expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();

    // A 标签页登录另一账号：共享通道从未建立，B 收不到任何事件
    graphQLLoginMock.mockResolvedValue(snapshot(900202, 'A2'));
    await loginWithPassword({ loginName: 'a2', loginPassword: 'pw' });

    // A 标签页退出：同样不发布事件
    await expect(logoutAuthSessionWithSignOut()).resolves.toBe('ok');

    expect(FakeBroadcastChannel.constructedCount).toBe(0);

    // B 标签页的会话（独立 sessionStorage，从未被 A 的操作写过）面对最坏情况——
    // 事件处理函数被直接调用——仍保持原会话、不触发整页跳转（返回 false）
    authSessionStore.establishSession(snapshot(900101, 'A1'));
    await expect(
      applyCrossTabSessionEvent({ type: 'session-replaced', accountId: 900202 }),
    ).resolves.toBe(false);
    expect(getCurrentAuthSession()?.accountId).toBe(900101);
    await expect(applyCrossTabSessionEvent({ type: 'logout' })).resolves.toBe(false);
    expect(getCurrentAuthSession()?.accountId).toBe(900101);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('关闭状态不错误清理页面数据或缓存：事件处理不触达 Apollo 缓存', async () => {
    authSessionStore.establishSession(snapshot(900101, 'A1'));

    await expect(applyCrossTabSessionEvent({ type: 'logout' })).resolves.toBe(false);
    await expect(
      applyCrossTabSessionEvent({ type: 'session-replaced', accountId: 900202 }),
    ).resolves.toBe(false);

    expect(clearCacheMock).not.toHaveBeenCalled();
    expect(getCurrentAuthSession()?.accountId).toBe(900101);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toContain('900101');
  });

  it('无会话时事件处理也不改变恢复状态（关闭态恢复语义仍是同步 restored）', async () => {
    authSessionStore.clearSession();

    await expect(applyCrossTabSessionEvent({ type: 'logout' })).resolves.toBe(false);
    await expect(
      applyCrossTabSessionEvent({ type: 'session-replaced', accountId: 900202 }),
    ).resolves.toBe(false);

    // 关闭态恢复语义零改动：不发起网络请求、同步返回（改造前行为）
    expect(ensureWebSessionRestored()).toBe('restored');
    expect(FakeBroadcastChannel.constructedCount).toBe(0);
  });
});
