// src/features/auth-session/infrastructure/auth-session-storage.spec.ts

import { describe, expect, it } from 'vitest';

import { createAuthSessionSnapshot } from '../application/auth-session-policy';

import {
  type AuthSessionStorageBackend,
  createAuthSessionPersistence,
} from './auth-session-storage';

const AUTH_SESSION_STORAGE_KEY = 'lithography-platform.auth-session.v1';

function createMemoryStorage(): AuthSessionStorageBackend & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>();

  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
    values,
  };
}

const SUPER_ADMIN_SESSION = createAuthSessionSnapshot({
  accessToken: 'access-token',
  accountId: 900001,
  adminLevel: 1,
  customerOrganizationId: null,
  restriction: 'NONE',
  role: 'SUPER_ADMIN',
  userInfo: {
    accessGroup: ['SUPER_ADMIN'],
    avatarUrl: 'https://example.test/avatar/admin.png',
    nickname: '系统管理员',
  },
});

function createStoredSession(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    accessToken: SUPER_ADMIN_SESSION.accessToken,
    accountId: SUPER_ADMIN_SESSION.accountId,
    adminLevel: SUPER_ADMIN_SESSION.adminLevel,
    customerOrganizationId: SUPER_ADMIN_SESSION.customerOrganizationId,
    engineerOrganizationId: SUPER_ADMIN_SESSION.engineerOrganizationId,
    adminOrganizationId: SUPER_ADMIN_SESSION.adminOrganizationId,
    registrationOrganizationId: SUPER_ADMIN_SESSION.registrationOrganizationId,
    restriction: SUPER_ADMIN_SESSION.restriction,
    role: SUPER_ADMIN_SESSION.role,
    userInfo: SUPER_ADMIN_SESSION.userInfo,
    version: 3,
    ...overrides,
  });
}

describe('auth session storage', () => {
  it('persists and restores only the normalized minimal session', () => {
    const storage = createMemoryStorage();
    const persistence = createAuthSessionPersistence(() => storage);

    persistence.write(SUPER_ADMIN_SESSION);

    expect(persistence.read()).toEqual(SUPER_ADMIN_SESSION);
    expect([...storage.values.values()][0]).toContain('"version":3');
    expect([...storage.values.values()][0]).not.toContain('refreshToken');
    expect([...storage.values.values()][0]).not.toContain('metaDigest');
  });

  it('restores a snapshot missing the new session facts with safe defaults', () => {
    const storage = createMemoryStorage();
    const persistence = createAuthSessionPersistence(() => storage);

    // v3 快照缺失限制状态 / 身份扩展字段：按 NONE / null 恢复，不丢会话
    storage.setItem(
      AUTH_SESSION_STORAGE_KEY,
      createStoredSession({
        adminLevel: undefined,
        customerOrganizationId: undefined,
        engineerOrganizationId: undefined,
        adminOrganizationId: undefined,
        registrationOrganizationId: undefined,
        restriction: undefined,
      }),
    );

    expect(persistence.read()).toEqual({
      ...SUPER_ADMIN_SESSION,
      adminLevel: null,
      engineerOrganizationId: null,
      adminOrganizationId: null,
      registrationOrganizationId: null,
      restriction: 'NONE',
    });
  });

  it('restores a legacy snapshot without avatarUrl as null instead of dropping the session', () => {
    const storage = createMemoryStorage();
    const persistence = createAuthSessionPersistence(() => storage);

    // 旧版本持久化快照没有头像字段：展示性字段缺失不得判定会话非法（否则老用户刷新即掉线）
    storage.setItem(
      AUTH_SESSION_STORAGE_KEY,
      createStoredSession({
        userInfo: { accessGroup: ['SUPER_ADMIN'], nickname: '系统管理员' },
      }),
    );

    expect(persistence.read()).toEqual({
      ...SUPER_ADMIN_SESSION,
      userInfo: { accessGroup: ['SUPER_ADMIN'], avatarUrl: null, nickname: '系统管理员' },
    });
  });

  it.each([
    ['an empty payload', ''],
    ['an unknown version', createStoredSession({ version: 4 })],
    ['a legacy v1 payload', createStoredSession({ version: 1 })],
    ['an empty token', createStoredSession({ accessToken: ' ' })],
    ['missing fields', JSON.stringify({ version: 3 })],
    ['invalid JSON', '{invalid json'],
  ])('removes %s instead of restoring it', (_caseName, storedValue) => {
    const storage = createMemoryStorage();
    const persistence = createAuthSessionPersistence(() => storage);

    storage.setItem(AUTH_SESSION_STORAGE_KEY, storedValue);

    expect(persistence.read()).toBeNull();
    expect(storage.values.size).toBe(0);
  });

  it('does not throw when storage methods fail', () => {
    const storage: AuthSessionStorageBackend = {
      getItem() {
        throw new Error('storage read failed');
      },
      removeItem() {
        throw new Error('storage clear failed');
      },
      setItem() {
        throw new Error('storage write failed');
      },
    };
    const persistence = createAuthSessionPersistence(() => storage);

    expect(persistence.read()).toBeNull();
    expect(() => persistence.write(SUPER_ADMIN_SESSION)).not.toThrow();
    expect(() => persistence.clear()).not.toThrow();
  });

  it('fails closed when session storage is unavailable', () => {
    const persistence = createAuthSessionPersistence(() => null);

    expect(persistence.read()).toBeNull();
    expect(() => persistence.write(SUPER_ADMIN_SESSION)).not.toThrow();
    expect(() => persistence.clear()).not.toThrow();
  });
});
