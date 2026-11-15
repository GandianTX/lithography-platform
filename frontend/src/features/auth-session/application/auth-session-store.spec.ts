// src/features/auth-session/application/auth-session-store.spec.ts

import { describe, expect, it, vi } from 'vitest';

import type { AuthSessionPersistence, AuthSessionSnapshot } from './auth-session.types';
import { createAuthSessionStore } from './auth-session-store';

function createMemoryPersistence(initialSession: AuthSessionSnapshot | null = null) {
  let storedSession = initialSession;
  const persistence: AuthSessionPersistence = {
    clear() {
      storedSession = null;
    },
    read() {
      return storedSession;
    },
    write(session) {
      storedSession = session;
    },
  };

  return {
    getStoredSession: () => storedSession,
    persistence,
  };
}

const ENGINEER_SESSION: AuthSessionSnapshot = {
  accessToken: 'access-token',
  accountId: 900101,
  adminLevel: null,
  customerOrganizationId: null,
  engineerOrganizationId: null,
  adminOrganizationId: null,
  registrationOrganizationId: null,
  restriction: 'NONE',
  role: 'ENGINEER',
  userInfo: {
    accessGroup: ['ENGINEER'],
    avatarUrl: 'https://example.test/avatar/chen.png',
    nickname: '陈工',
  },
};

describe('auth session store', () => {
  it('restores the initial session from the single persistence boundary', () => {
    const { persistence } = createMemoryPersistence(ENGINEER_SESSION);
    const store = createAuthSessionStore(persistence);

    expect(store.getSnapshot()).toEqual({
      session: ENGINEER_SESSION,
      status: 'authenticated',
    });
  });

  it('establishes and clears one atomic session state', () => {
    const { getStoredSession, persistence } = createMemoryPersistence();
    const store = createAuthSessionStore(persistence);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.establishSession({
      accessToken: ENGINEER_SESSION.accessToken,
      accountId: ENGINEER_SESSION.accountId,
      role: ENGINEER_SESSION.role,
      userInfo: ENGINEER_SESSION.userInfo,
    });

    expect(store.getSnapshot().status).toBe('authenticated');
    expect(getStoredSession()).toEqual(ENGINEER_SESSION);

    store.clearSession();

    expect(store.getSnapshot()).toEqual({ session: null, status: 'anonymous' });
    expect(getStoredSession()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('does not persist or publish an invalid session', () => {
    const { getStoredSession, persistence } = createMemoryPersistence();
    const store = createAuthSessionStore(persistence);
    const listener = vi.fn();

    store.subscribe(listener);

    expect(() =>
      store.establishSession({
        accessToken: ' ',
        accountId: 900101,
        role: 'ENGINEER',
        userInfo: null,
      }),
    ).toThrow('Cannot establish an invalid auth session.');
    expect(store.getSnapshot()).toEqual({ session: null, status: 'anonymous' });
    expect(getStoredSession()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  describe('updateNickname（显示昵称窄入口）', () => {
    it('accountId 匹配时同步写持久化与内存并发布，昵称经 snapshot 工厂 trim', () => {
      const { getStoredSession, persistence } = createMemoryPersistence(ENGINEER_SESSION);
      const store = createAuthSessionStore(persistence);
      const listener = vi.fn();

      store.subscribe(listener);

      const updated = store.updateNickname({
        accountId: ENGINEER_SESSION.accountId,
        nickname: '  陈工程  ',
      });

      expect(updated).toBe(true);
      expect(store.getSnapshot().session?.userInfo?.nickname).toBe('陈工程');
      expect(getStoredSession()?.userInfo?.nickname).toBe('陈工程');
      expect(listener).toHaveBeenCalledTimes(1);

      store.establishSession(ENGINEER_SESSION);
    });

    it('昵称更新只触碰 userInfo.nickname：Token、accountId、role、accessGroup 逐字段保持不变', () => {
      const { getStoredSession, persistence } = createMemoryPersistence(ENGINEER_SESSION);
      const store = createAuthSessionStore(persistence);

      expect(store.updateNickname({ accountId: 900101, nickname: '同步后的昵称' })).toBe(true);

      const session = store.getSnapshot().session;
      expect(session).not.toBeNull();
      // 除 nickname 外的所有会话字段与更新前逐字段一致（联系方式/凭据类保存不得带来其他改写）
      expect(session?.accessToken).toBe(ENGINEER_SESSION.accessToken);
      expect(session?.accountId).toBe(ENGINEER_SESSION.accountId);
      expect(session?.role).toBe(ENGINEER_SESSION.role);
      expect(session?.userInfo?.accessGroup).toEqual(ENGINEER_SESSION.userInfo?.accessGroup);
      expect(session?.userInfo?.avatarUrl).toBe(ENGINEER_SESSION.userInfo?.avatarUrl);
      expect(session?.userInfo?.nickname).toBe('同步后的昵称');
      expect(getStoredSession()).toEqual(session);
    });

    it('昵称回写保留受限状态与身份扩展字段（不得把受限会话洗成正常会话）', () => {
      const restrictedSession: AuthSessionSnapshot = {
        ...ENGINEER_SESSION,
        adminLevel: 3,
        customerOrganizationId: 4401,
        restriction: 'ENGINEER_PENDING',
      };
      const { getStoredSession, persistence } = createMemoryPersistence(restrictedSession);
      const store = createAuthSessionStore(persistence);

      expect(store.updateNickname({ accountId: 900101, nickname: '待审工程师' })).toBe(true);

      const session = store.getSnapshot().session;
      expect(session?.restriction).toBe('ENGINEER_PENDING');
      expect(session?.adminLevel).toBe(3);
      expect(session?.customerOrganizationId).toBe(4401);
      expect(getStoredSession()?.restriction).toBe('ENGINEER_PENDING');
    });

    it('accountId 不匹配时一律不更新（过期视图不得写入他人会话）', () => {
      const { getStoredSession, persistence } = createMemoryPersistence(ENGINEER_SESSION);
      const store = createAuthSessionStore(persistence);
      const listener = vi.fn();

      store.subscribe(listener);

      const updated = store.updateNickname({ accountId: 999999, nickname: '别人的昵称' });

      expect(updated).toBe(false);
      expect(store.getSnapshot().session?.userInfo?.nickname).toBe('陈工');
      expect(getStoredSession()?.userInfo?.nickname).toBe('陈工');
      expect(listener).not.toHaveBeenCalled();
    });

    it('无会话时返回 false 且不发布', () => {
      const { persistence } = createMemoryPersistence();
      const store = createAuthSessionStore(persistence);
      const listener = vi.fn();

      store.subscribe(listener);

      expect(store.updateNickname({ accountId: 900101, nickname: '新昵称' })).toBe(false);
      expect(store.getSnapshot().status).toBe('anonymous');
      expect(listener).not.toHaveBeenCalled();
    });

    it('无 userInfo 的会话没有显示昵称面，返回 false 且不更新', () => {
      const sessionWithoutUserInfo: AuthSessionSnapshot = {
        accessToken: 'access-token',
        accountId: 900102,
        adminLevel: null,
        customerOrganizationId: null,
        engineerOrganizationId: null,
        adminOrganizationId: null,
        registrationOrganizationId: null,
        restriction: 'NONE',
        role: 'CUSTOMER',
        userInfo: null,
      };
      const { getStoredSession, persistence } = createMemoryPersistence(sessionWithoutUserInfo);
      const store = createAuthSessionStore(persistence);
      const listener = vi.fn();

      store.subscribe(listener);

      expect(store.updateNickname({ accountId: 900102, nickname: '新昵称' })).toBe(false);
      expect(store.getSnapshot().session).toEqual(sessionWithoutUserInfo);
      expect(getStoredSession()).toEqual(sessionWithoutUserInfo);
      expect(listener).not.toHaveBeenCalled();
    });

    it('空白昵称触发 snapshot 工厂不变量失败，不持久化、不发布', () => {
      const { getStoredSession, persistence } = createMemoryPersistence(ENGINEER_SESSION);
      const store = createAuthSessionStore(persistence);
      const listener = vi.fn();

      store.subscribe(listener);

      expect(() =>
        store.updateNickname({ accountId: ENGINEER_SESSION.accountId, nickname: '   ' }),
      ).toThrow('Cannot establish an invalid auth session.');
      expect(store.getSnapshot().session?.userInfo?.nickname).toBe('陈工');
      expect(getStoredSession()?.userInfo?.nickname).toBe('陈工');
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('会话代次（迟到响应裁决）', () => {
    it('建立会话后采样到不含 Token 的身份：accountId + 初始代次', () => {
      const { persistence } = createMemoryPersistence();
      const store = createAuthSessionStore(persistence);

      store.establishSession(ENGINEER_SESSION);

      const identity = store.sampleSessionIdentity();

      expect(identity).toEqual({ accountId: 900101, epoch: 1 });
      // 窄身份绝不携带 Token：JSON 序列化后也不得出现任何会话凭据
      expect(JSON.stringify(identity)).not.toContain('access-token');
    });

    it('昵称回写不推进代次：回写后采样身份仍与发起时一致', () => {
      const { persistence } = createMemoryPersistence();
      const store = createAuthSessionStore(persistence);

      store.establishSession(ENGINEER_SESSION);
      const identityBefore = store.sampleSessionIdentity();

      store.updateNickname({ accountId: 900101, nickname: '新昵称' });

      expect(store.sampleSessionIdentity()).toEqual(identityBefore);
      expect(store.sampleSessionIdentity()).toEqual({ accountId: 900101, epoch: 1 });
    });

    it('清除会话推进代次：清除后采样为 null，旧身份不再匹配', () => {
      const { persistence } = createMemoryPersistence(ENGINEER_SESSION);
      const store = createAuthSessionStore(persistence);
      const identityBefore = store.sampleSessionIdentity();

      store.clearSession();

      expect(store.sampleSessionIdentity()).toBeNull();
      expect(store.clearSessionIfIdentityMatches(identityBefore)).toBe(false);
    });

    it('同一账号退出后重新登录得到新代次：发起时的旧身份不再匹配新会话', () => {
      const { persistence } = createMemoryPersistence();
      const store = createAuthSessionStore(persistence);

      store.establishSession(ENGINEER_SESSION);
      const identityOfFirstLogin = store.sampleSessionIdentity();

      store.clearSession();
      store.establishSession(ENGINEER_SESSION);

      // 同一个账号、同一个 Token 值，但这是「退出后重新登录」的新会话
      expect(store.sampleSessionIdentity()).not.toEqual(identityOfFirstLogin);
      expect(store.getSnapshot().session?.accountId).toBe(identityOfFirstLogin?.accountId);
      expect(store.clearSessionIfIdentityMatches(identityOfFirstLogin)).toBe(false);
      expect(store.getSnapshot().status).toBe('authenticated');
    });

    it('刷新后恢复会话建立新代次：恢复前采样的身份不再匹配', () => {
      const { persistence } = createMemoryPersistence(ENGINEER_SESSION);
      const store = createAuthSessionStore(persistence);
      const identityBeforeRestore = store.sampleSessionIdentity();

      store.restoreSession();

      expect(store.sampleSessionIdentity()).not.toEqual(identityBeforeRestore);
      expect(store.clearSessionIfIdentityMatches(identityBeforeRestore)).toBe(false);
    });

    it('身份匹配时清理会话并返回 true，持久化同步清空', () => {
      const { getStoredSession, persistence } = createMemoryPersistence(ENGINEER_SESSION);
      const store = createAuthSessionStore(persistence);
      const identity = store.sampleSessionIdentity();

      expect(store.clearSessionIfIdentityMatches(identity)).toBe(true);
      expect(store.getSnapshot()).toEqual({ session: null, status: 'anonymous' });
      expect(getStoredSession()).toBeNull();
    });

    it('账号不同的身份不匹配：迟到响应不得清除他人会话', () => {
      const { getStoredSession, persistence } = createMemoryPersistence(ENGINEER_SESSION);
      const store = createAuthSessionStore(persistence);

      expect(store.clearSessionIfIdentityMatches({ accountId: 999999, epoch: 1 })).toBe(false);
      expect(store.getSnapshot().status).toBe('authenticated');
      expect(getStoredSession()).toEqual(ENGINEER_SESSION);
    });

    it('null 身份（装配层未接入采样）fail-closed：绝不清除任何会话', () => {
      const { getStoredSession, persistence } = createMemoryPersistence(ENGINEER_SESSION);
      const store = createAuthSessionStore(persistence);

      expect(store.clearSessionIfIdentityMatches(null)).toBe(false);
      expect(store.getSnapshot().status).toBe('authenticated');
      expect(getStoredSession()).toEqual(ENGINEER_SESSION);
    });

    it('无会话时条件清除返回 false', () => {
      const { persistence } = createMemoryPersistence();
      const store = createAuthSessionStore(persistence);

      expect(store.clearSessionIfIdentityMatches({ accountId: 900101, epoch: 1 })).toBe(false);
      expect(store.sampleSessionIdentity()).toBeNull();
    });
  });

  describe('服务端身份复核回写', () => {
    it('同一会话代次时写入服务端复核出的限制状态与身份扩展字段', () => {
      const { getStoredSession, persistence } = createMemoryPersistence(ENGINEER_SESSION);
      const store = createAuthSessionStore(persistence);
      const identity = store.sampleSessionIdentity();

      expect(identity).not.toBeNull();

      const updated = store.applySessionIdentity({
        identity: identity!,
        adminLevel: 2,
        customerOrganizationId: 950001,
        engineerOrganizationId: 7701,
        adminOrganizationId: 8801,
        registrationOrganizationId: 6601,
        restriction: 'MUST_CHANGE_PASSWORD',
      });

      expect(updated).toBe(true);
      expect(store.getSnapshot().session).toMatchObject({
        accessToken: ENGINEER_SESSION.accessToken,
        accountId: ENGINEER_SESSION.accountId,
        adminLevel: 2,
        customerOrganizationId: 950001,
        engineerOrganizationId: 7701,
        adminOrganizationId: 8801,
        registrationOrganizationId: 6601,
        restriction: 'MUST_CHANGE_PASSWORD',
        role: ENGINEER_SESSION.role,
        userInfo: ENGINEER_SESSION.userInfo,
      });
      expect(getStoredSession()?.restriction).toBe('MUST_CHANGE_PASSWORD');
    });

    it('值无变化时不写盘、不发布', () => {
      const { persistence } = createMemoryPersistence(ENGINEER_SESSION);
      const store = createAuthSessionStore(persistence);
      const listener = vi.fn();

      store.subscribe(listener);

      expect(
        store.applySessionIdentity({
          identity: store.sampleSessionIdentity()!,
          adminLevel: null,
          customerOrganizationId: null,
          engineerOrganizationId: null,
          adminOrganizationId: null,
          registrationOrganizationId: null,
          restriction: 'NONE',
        }),
      ).toBe(false);
      expect(listener).not.toHaveBeenCalled();
    });

    it('会话代次变化（退出重登 / 刷新恢复）后的迟到复核结果被丢弃', () => {
      const { getStoredSession, persistence } = createMemoryPersistence(ENGINEER_SESSION);
      const store = createAuthSessionStore(persistence);
      const identityBeforeRestore = store.sampleSessionIdentity();

      store.restoreSession();

      expect(
        store.applySessionIdentity({
          identity: identityBeforeRestore!,
          adminLevel: 1,
          customerOrganizationId: null,
          engineerOrganizationId: null,
          adminOrganizationId: null,
          registrationOrganizationId: null,
          restriction: 'ENGINEER_PENDING',
        }),
      ).toBe(false);
      expect(store.getSnapshot().session?.restriction).toBe('NONE');
      expect(getStoredSession()?.restriction).toBe('NONE');
    });
  });
});
