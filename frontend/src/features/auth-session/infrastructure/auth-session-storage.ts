// src/features/auth-session/infrastructure/auth-session-storage.ts

import type {
  AuthSessionPersistence,
  AuthSessionSnapshot,
} from '../application/auth-session.types';

import { decodeAuthSessionPayload, isRecord } from './auth-session-mapper';

const AUTH_SESSION_STORAGE_KEY = 'lithography-platform.auth-session.v1';
// v2 起持久化 restriction / adminLevel / customerOrganizationId；v3 再增可信组织身份
// 三个字段（engineer/admin/registrationOrganizationId）。读到旧版本（v1 / v2）时按既有
// 「未知版本」口径清除，用户重新登录即可获得完整会话快照
const AUTH_SESSION_STORAGE_VERSION = 3;

export type AuthSessionStorageBackend = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

function getBrowserSessionStorage(): AuthSessionStorageBackend | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function serializeAuthSession(session: AuthSessionSnapshot): string {
  return JSON.stringify({
    accessToken: session.accessToken,
    accountId: session.accountId,
    adminLevel: session.adminLevel,
    customerOrganizationId: session.customerOrganizationId,
    engineerOrganizationId: session.engineerOrganizationId,
    adminOrganizationId: session.adminOrganizationId,
    registrationOrganizationId: session.registrationOrganizationId,
    restriction: session.restriction,
    role: session.role,
    userInfo: session.userInfo
      ? {
          accessGroup: [...session.userInfo.accessGroup],
          avatarUrl: session.userInfo.avatarUrl,
          nickname: session.userInfo.nickname,
        }
      : null,
    version: AUTH_SESSION_STORAGE_VERSION,
  });
}

function decodeStoredAuthSession(value: unknown): AuthSessionSnapshot | null {
  if (!isRecord(value) || value.version !== AUTH_SESSION_STORAGE_VERSION) {
    return null;
  }

  return decodeAuthSessionPayload(value);
}

export function createAuthSessionPersistence(
  getStorage: () => AuthSessionStorageBackend | null = getBrowserSessionStorage,
): AuthSessionPersistence {
  function clear() {
    try {
      getStorage()?.removeItem(AUTH_SESSION_STORAGE_KEY);
    } catch {
      // Session storage can be unavailable in restricted browser contexts.
    }
  }

  return {
    clear,
    read() {
      let rawValue: string | null;

      try {
        rawValue = getStorage()?.getItem(AUTH_SESSION_STORAGE_KEY) ?? null;
      } catch {
        return null;
      }

      if (rawValue === null) {
        return null;
      }

      try {
        const session = decodeStoredAuthSession(JSON.parse(rawValue) as unknown);

        if (!session) {
          clear();
        }

        return session;
      } catch {
        clear();
        return null;
      }
    },
    write(session) {
      try {
        getStorage()?.setItem(AUTH_SESSION_STORAGE_KEY, serializeAuthSession(session));
      } catch {
        // Keep the in-memory session usable even when persistence is unavailable.
      }
    },
  };
}

export const browserAuthSessionPersistence = createAuthSessionPersistence();
