// src/features/auth-session/auth-session-entry.spec.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionIdentitySnapshot } from './infrastructure/auth-session-identity-graphql';
import { fetchMySessionIdentity } from './infrastructure/auth-session-identity-graphql';
import {
  authSessionStore,
  getAuthSessionAccessToken,
  getCurrentAuthSession,
  hasCurrentAuthSession,
  logoutAuthSession,
  refreshCurrentAuthSessionIdentity,
} from './auth-session-entry';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, reject, resolve };
}

function identitySnapshot(
  restriction: SessionIdentitySnapshot['restriction'],
): SessionIdentitySnapshot {
  return {
    accountId: 900201,
    adminLevel: null,
    customerOrganizationId: null,
    engineerOrganizationId: null,
    adminOrganizationId: null,
    registrationOrganizationId: null,
    restriction,
  };
}

// 只在基础设施边界桩掉网络：入口层「采样身份 → 服务端复核 → 代次保护写入」的
// 编排仍走真实实现（store + 浏览器持久化）。
vi.mock('./infrastructure/auth-session-identity-graphql', () => ({
  fetchMySessionIdentity: vi.fn(),
}));

const fetchMySessionIdentityMock = vi.mocked(fetchMySessionIdentity);

// 经生产装配（真实 store + 浏览器持久化适配器 + Apollo cache 适配器）直测入口读取
// 与失效清理，不复制业务规则；jsdom 提供真实的 window.sessionStorage。
const AUTH_SESSION_STORAGE_KEY = 'lithography-platform.auth-session.v1';

describe('auth session entry', () => {
  beforeEach(() => {
    fetchMySessionIdentityMock.mockReset();
  });

  afterEach(() => {
    authSessionStore.clearSession();
  });

  it('reports no session and no access token in the anonymous state', () => {
    authSessionStore.clearSession();

    expect(getCurrentAuthSession()).toBeNull();
    expect(hasCurrentAuthSession()).toBe(false);
    expect(getAuthSessionAccessToken()).toBeNull();
  });

  it('exposes the established session and its access token', () => {
    authSessionStore.establishSession({
      accessToken: 'entry-access-token',
      accountId: 900201,
      role: 'CUSTOMER',
      userInfo: { accessGroup: ['CUSTOMER'], avatarUrl: null, nickname: '测试会话' },
    });

    expect(hasCurrentAuthSession()).toBe(true);
    expect(getAuthSessionAccessToken()).toBe('entry-access-token');
    expect(getCurrentAuthSession()).toMatchObject({
      accountId: 900201,
      role: 'CUSTOMER',
    });
    expect(window.sessionStorage.getItem(AUTH_SESSION_STORAGE_KEY)).not.toBeNull();
  });

  it('logout clears the session owner and the persisted storage', async () => {
    authSessionStore.establishSession({
      accessToken: 'entry-access-token',
      accountId: 900201,
      role: 'CUSTOMER',
      userInfo: null,
    });
    expect(hasCurrentAuthSession()).toBe(true);

    await logoutAuthSession();

    expect(hasCurrentAuthSession()).toBe(false);
    expect(getCurrentAuthSession()).toBeNull();
    expect(getAuthSessionAccessToken()).toBeNull();
    expect(window.sessionStorage.getItem(AUTH_SESSION_STORAGE_KEY)).toBeNull();
  });

  describe('refreshCurrentAuthSessionIdentity（启动期服务端复核）', () => {
    it('无会话时不请求服务端', async () => {
      authSessionStore.clearSession();

      await expect(refreshCurrentAuthSessionIdentity()).resolves.toEqual({ status: 'stale' });
      expect(fetchMySessionIdentityMock).not.toHaveBeenCalled();
    });

    it('服务端复核结果回写 restriction 与身份扩展字段并持久化', async () => {
      authSessionStore.establishSession({
        accessToken: 'entry-access-token',
        accountId: 900201,
        role: 'ENGINEER',
        userInfo: { accessGroup: ['ENGINEER'], avatarUrl: null, nickname: '待审工程师' },
      });
      fetchMySessionIdentityMock.mockResolvedValue({
        accountId: 900201,
        adminLevel: 2,
        customerOrganizationId: 4401,
        engineerOrganizationId: 7701,
        adminOrganizationId: 8801,
        registrationOrganizationId: 6601,
        restriction: 'ENGINEER_PENDING',
      });

      await expect(refreshCurrentAuthSessionIdentity()).resolves.toEqual({ status: 'applied' });

      expect(getCurrentAuthSession()).toMatchObject({
        adminLevel: 2,
        customerOrganizationId: 4401,
        engineerOrganizationId: 7701,
        adminOrganizationId: 8801,
        registrationOrganizationId: 6601,
        restriction: 'ENGINEER_PENDING',
      });
      expect(window.sessionStorage.getItem(AUTH_SESSION_STORAGE_KEY)).toContain('ENGINEER_PENDING');
    });

    it('限制状态缺失（null）时不写入，避免把受限会话误当成正常会话', async () => {
      authSessionStore.establishSession({
        accessToken: 'entry-access-token',
        accountId: 900201,
        role: 'ENGINEER',
        userInfo: null,
      });
      fetchMySessionIdentityMock.mockResolvedValue({
        accountId: 900201,
        adminLevel: null,
        customerOrganizationId: null,
        engineerOrganizationId: null,
        adminOrganizationId: null,
        registrationOrganizationId: null,
        restriction: null,
      });

      await expect(refreshCurrentAuthSessionIdentity()).resolves.toEqual({ status: 'stale' });

      expect(getCurrentAuthSession()?.restriction).toBe('NONE');
    });

    it('响应账号与当前会话不一致时不写入（迟到结果不得改写他人会话）', async () => {
      authSessionStore.establishSession({
        accessToken: 'entry-access-token',
        accountId: 900201,
        role: 'CUSTOMER',
        userInfo: null,
      });
      fetchMySessionIdentityMock.mockResolvedValue({
        accountId: 999999,
        adminLevel: null,
        customerOrganizationId: null,
        engineerOrganizationId: null,
        adminOrganizationId: null,
        registrationOrganizationId: null,
        restriction: 'MUST_CHANGE_PASSWORD',
      });

      await expect(refreshCurrentAuthSessionIdentity()).resolves.toEqual({ status: 'stale' });

      expect(getCurrentAuthSession()?.restriction).toBe('NONE');
    });

    it('并发复核乱序返回时只写入最新请求，旧响应不得回退限制状态', async () => {
      authSessionStore.establishSession({
        accessToken: 'entry-access-token',
        accountId: 900201,
        role: 'ENGINEER',
        restriction: 'ENGINEER_PENDING',
        userInfo: null,
      });
      const older = deferred<SessionIdentitySnapshot | null>();
      const latest = deferred<SessionIdentitySnapshot | null>();
      fetchMySessionIdentityMock
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(latest.promise);

      const olderCall = refreshCurrentAuthSessionIdentity();
      const latestCall = refreshCurrentAuthSessionIdentity();

      latest.resolve(identitySnapshot('NONE'));
      await expect(latestCall).resolves.toEqual({ status: 'applied' });
      expect(getCurrentAuthSession()?.restriction).toBe('NONE');

      // 旧请求迟到：必须被序号保护丢弃，不能把刚确认的 NONE 回退成待审
      older.resolve(identitySnapshot('ENGINEER_PENDING'));
      await expect(olderCall).resolves.toEqual({ status: 'stale' });
      expect(getCurrentAuthSession()?.restriction).toBe('NONE');
    });

    it('最新请求失败时不回退到更早请求的成功结果', async () => {
      authSessionStore.establishSession({
        accessToken: 'entry-access-token',
        accountId: 900201,
        role: 'ENGINEER',
        restriction: 'ENGINEER_PENDING',
        userInfo: null,
      });
      const older = deferred<SessionIdentitySnapshot | null>();
      fetchMySessionIdentityMock
        .mockReturnValueOnce(older.promise)
        .mockRejectedValueOnce(new Error('network'));

      const olderCall = refreshCurrentAuthSessionIdentity();
      const latestCall = refreshCurrentAuthSessionIdentity();

      await expect(latestCall).rejects.toThrow('network');

      older.resolve(identitySnapshot('NONE'));
      await expect(olderCall).resolves.toEqual({ status: 'stale' });
      expect(getCurrentAuthSession()?.restriction).toBe('ENGINEER_PENDING');
    });

    it('复核结果与当前快照一致时返回 unchanged（区别于迟到 / 无效的 stale）', async () => {
      authSessionStore.establishSession({
        accessToken: 'entry-access-token',
        accountId: 900201,
        role: 'ENGINEER',
        userInfo: null,
      });
      fetchMySessionIdentityMock.mockResolvedValue(identitySnapshot('NONE'));

      await expect(refreshCurrentAuthSessionIdentity()).resolves.toEqual({ status: 'unchanged' });
      expect(getCurrentAuthSession()?.restriction).toBe('NONE');
    });
  });
});
