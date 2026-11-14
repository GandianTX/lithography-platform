// src/features/auth-session/application/auth-session-store.ts

import type {
  AuthSessionIdentity,
  AuthSessionPersistence,
  AuthSessionRestriction,
  AuthSessionState,
  EstablishAuthSessionInput,
} from './auth-session.types';
import { createAuthSessionSnapshot } from './auth-session-policy';

type AuthSessionListener = () => void;

const ANONYMOUS_AUTH_SESSION_STATE: AuthSessionState = {
  session: null,
  status: 'anonymous',
};

export type AuthSessionStore = {
  /**
   * 用服务端复核结果校对当前会话的限制状态与身份扩展字段。
   * 仅当 identity 仍描述当前会话（同账号且同会话代次）时生效并返回 true；
   * 值无变化或身份不匹配时不写盘、不发布并返回 false（迟到响应不得改写当前会话）。
   */
  applySessionIdentity: (input: {
    identity: AuthSessionIdentity;
    adminLevel: number | null;
    customerOrganizationId: number | null;
    restriction: AuthSessionRestriction;
  }) => boolean;
  clearSession: () => void;
  /**
   * 仅当 identity 仍描述当前会话（同账号且同会话代次）时清理会话真源并返回 true；
   * identity 为 null（装配层未接入采样）或不匹配（退出重登 / 已切换账号的迟到响应）
   * 时不做任何清理并返回 false——迟到响应不得打断当前会话。
   */
  clearSessionIfIdentityMatches: (identity: AuthSessionIdentity | null) => boolean;
  establishSession: (input: EstablishAuthSessionInput) => void;
  getSnapshot: () => AuthSessionState;
  restoreSession: () => void;
  /** 请求发起前采样当前会话身份（不含 Token）；无会话时返回 null */
  sampleSessionIdentity: () => AuthSessionIdentity | null;
  /**
   * 仅更新显示昵称的窄入口：accountId 与当前会话一致且新昵称合法时，
   * 同步写持久化（sessionStorage）与内存状态并发布；其余情况一律不更新。
   * 返回是否发生了更新（供调用方在需要时感知）。
   */
  updateNickname: (input: { accountId: number; nickname: string }) => boolean;
  subscribe: (listener: AuthSessionListener) => () => void;
};

function restoreState(persistence: AuthSessionPersistence): AuthSessionState {
  const session = persistence.read();

  return session
    ? {
        session,
        status: 'authenticated',
      }
    : ANONYMOUS_AUTH_SESSION_STATE;
}

export function createAuthSessionStore(persistence: AuthSessionPersistence): AuthSessionStore {
  const listeners = new Set<AuthSessionListener>();
  let state = restoreState(persistence);
  // 会话代次：不含 Token 的单调计数。建立（登录）/ 恢复（刷新后重建）/ 清除
  // （登出或会话失效）都推进代次；昵称回写等会话内更新不推进——它们不产生新会话。
  // 同一账号退出后重新登录必然得到更大的代次，用于区分「同一个账号」的先后会话。
  let sessionEpoch = 0;

  function publish(nextState: AuthSessionState) {
    state = nextState;
    listeners.forEach((listener) => listener());
  }

  const store: AuthSessionStore = {
    applySessionIdentity({ identity, adminLevel, customerOrganizationId, restriction }) {
      const current = state.session;

      // 未接入采样、当前无会话、或身份已变化：一律忽略（迟到响应 / 已切换账号）
      if (!current || current.accountId !== identity.accountId || sessionEpoch !== identity.epoch) {
        return false;
      }

      if (
        current.restriction === restriction &&
        current.adminLevel === adminLevel &&
        current.customerOrganizationId === customerOrganizationId
      ) {
        return false;
      }

      // 复用 snapshot 工厂：会话内其余字段与不变量保持不变，只替换服务端复核出的三项事实
      const next = createAuthSessionSnapshot({
        accessToken: current.accessToken,
        accountId: current.accountId,
        adminLevel,
        customerOrganizationId,
        restriction,
        role: current.role,
        userInfo: current.userInfo,
      });

      persistence.write(next);
      publish({ session: next, status: 'authenticated' });

      return true;
    },
    clearSession() {
      sessionEpoch += 1;
      persistence.clear();
      publish(ANONYMOUS_AUTH_SESSION_STATE);
    },
    clearSessionIfIdentityMatches(identity) {
      const current = state.session;

      // 未接入采样或当前无会话：fail-closed，绝不清除
      if (!identity || !current) {
        return false;
      }

      // 必须是「同一个账号的同一个会话代次」：退出重登、换账号都算不匹配
      if (current.accountId !== identity.accountId || sessionEpoch !== identity.epoch) {
        return false;
      }

      store.clearSession();

      return true;
    },
    establishSession(input) {
      const session = createAuthSessionSnapshot(input);

      sessionEpoch += 1;
      persistence.write(session);
      publish({ session, status: 'authenticated' });
    },
    getSnapshot() {
      return state;
    },
    restoreSession() {
      sessionEpoch += 1;
      publish(restoreState(persistence));
    },
    sampleSessionIdentity() {
      const current = state.session;

      return current ? { accountId: current.accountId, epoch: sessionEpoch } : null;
    },
    updateNickname({ accountId, nickname }) {
      const current = state.session;

      // 目标账号必须就是当前会话账号：账号设置只能改自己，不匹配视为
      // 「请求来自过期视图」直接忽略，绝不写入
      if (!current || current.accountId !== accountId) {
        return false;
      }

      // 无 userInfo 的会话没有显示昵称面（侧栏回退「当前用户」），无从更新
      if (!current.userInfo) {
        return false;
      }

      // 复用 snapshot 工厂完成 trim 与全部不变量校验（accessGroup / 角色一致性）；
      // 校验失败抛错属会话数据不变量被破坏，不在本方法内静默吞掉
      const next = createAuthSessionSnapshot({
        accessToken: current.accessToken,
        accountId: current.accountId,
        adminLevel: current.adminLevel,
        customerOrganizationId: current.customerOrganizationId,
        restriction: current.restriction,
        role: current.role,
        userInfo: {
          ...current.userInfo,
          nickname,
        },
      });

      persistence.write(next);
      publish({ session: next, status: 'authenticated' });

      return true;
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };

  return store;
}
