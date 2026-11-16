// src/features/auth-session/auth-session-entry.ts

import type { AuthSessionIdentity } from './application/auth-session.types';
import { createAuthSessionStore } from './application/auth-session-store';
import { createLoginWithPasswordUsecase } from './application/login-with-password';
import {
  createClearSessionAfterPasswordChangeUsecase,
  createLogoutAuthSessionUsecase,
} from './application/logout-auth-session';
import { apolloAuthSessionCache } from './infrastructure/apollo-session-cache';
import { graphQLAuthLoginGateway } from './infrastructure/auth-login-graphql';
import { fetchMySessionIdentity } from './infrastructure/auth-session-identity-graphql';
import { browserAuthSessionPersistence } from './infrastructure/auth-session-storage';

export const authSessionStore = createAuthSessionStore(browserAuthSessionPersistence);
const executeLoginWithPassword = createLoginWithPasswordUsecase({
  gateway: graphQLAuthLoginGateway,
  session: authSessionStore,
});
export const logoutAuthSession = createLogoutAuthSessionUsecase({
  cache: apolloAuthSessionCache,
  session: authSessionStore,
});
export const clearSessionAfterPasswordChange = createClearSessionAfterPasswordChangeUsecase({
  cache: apolloAuthSessionCache,
  session: authSessionStore,
});

export function getCurrentAuthSession() {
  return authSessionStore.getSnapshot().session;
}

export function hasCurrentAuthSession(): boolean {
  return getCurrentAuthSession() !== null;
}

export function getAuthSessionAccessToken(): string | null {
  return getCurrentAuthSession()?.accessToken ?? null;
}

/**
 * 请求发起前采样当前会话身份（不含 Token 的窄身份：accountId + 会话代次）。
 * 供改密等动作在发起时固化「这次动作属于哪个会话」，迟到响应由条件登出
 * 与当前会话比对裁决；无会话时返回 null。
 */
export function sampleCurrentAuthSessionIdentity(): AuthSessionIdentity | null {
  return authSessionStore.sampleSessionIdentity();
}

/**
 * 仅更新当前会话显示昵称的窄入口（账号设置资料保存成功后的回写面）。
 *
 * 只收窄到「昵称」这一件事：accountId 必须与当前会话一致、新昵称经 snapshot
 * 工厂校验后，内存状态与 sessionStorage 持久化同步更新并发布订阅；其余情况
 * 一律不更新。返回是否发生了更新。不暴露 Token / 角色等任何其他会话字段的
 * 写入口。
 */
export function updateCurrentAuthSessionNickname(accountId: number, nickname: string): boolean {
  return authSessionStore.updateNickname({ accountId, nickname });
}

/**
 * 一次会话身份复核的可判定结果。
 *
 * 调用方需要区分「服务端事实已确认但无变化」与「本次响应不代表当前会话」：
 * - `applied`：同账号同会话代次，服务端快照已写入并改变会话事实；
 * - `unchanged`：同账号同会话代次，服务端快照合法且与当前事实一致；
 * - `stale`：无会话、被更新的请求覆盖、账号/会话代次已变化或快照不合法——
 *   本次响应不得被当作当前会话的复核结论（迟到响应不得提升或回退资格）。
 */
export type AuthSessionIdentityRefreshOutcome =
  | { status: 'applied' }
  | { status: 'unchanged' }
  | { status: 'stale' };

/**
 * 启动 / 刷新时用服务端当前复核结果校对会话限制状态。
 *
 * 身份（账号 + 会话代次）在请求发起前采样；响应回来时若会话已变化（退出重登 /
 * 切换账号），store 侧拒绝写入。网络 / 认证失败按既有 ingress 链路上抛，由调用方
 * 决定是否静默（UNAUTHENTICATED 已由全局 auth failure handler 收口）。
 *
 * 并发保护：壳层启动复核、受限页显式刷新与批准结果的进入前复核可能重叠；
 * 只允许**最新一次**请求写入，更早请求的迟到响应一律丢弃，避免把刚确认的
 * NONE 回退成旧限制（旧响应也不得提升资格）。
 */
let identityRefreshSeq = 0;

export async function refreshCurrentAuthSessionIdentity(): Promise<AuthSessionIdentityRefreshOutcome> {
  const identity = authSessionStore.sampleSessionIdentity();

  if (!identity) {
    return { status: 'stale' };
  }

  const seq = identityRefreshSeq + 1;
  identityRefreshSeq = seq;

  const snapshot = await fetchMySessionIdentity();

  // 已有更新的复核请求发出：本次响应过期，不得写入
  if (seq !== identityRefreshSeq) {
    return { status: 'stale' };
  }

  if (!snapshot || snapshot.accountId !== identity.accountId || snapshot.restriction === null) {
    return { status: 'stale' };
  }

  // 等待期间退出重登或切换账号：响应描述的不再是当前会话
  const currentIdentity = authSessionStore.sampleSessionIdentity();
  if (
    !currentIdentity ||
    currentIdentity.accountId !== identity.accountId ||
    currentIdentity.epoch !== identity.epoch
  ) {
    return { status: 'stale' };
  }

  const applied = authSessionStore.applySessionIdentity({
    identity,
    adminLevel: snapshot.adminLevel,
    customerOrganizationId: snapshot.customerOrganizationId,
    engineerOrganizationId: snapshot.engineerOrganizationId,
    adminOrganizationId: snapshot.adminOrganizationId,
    registrationOrganizationId: snapshot.registrationOrganizationId,
    restriction: snapshot.restriction,
  });

  return applied ? { status: 'applied' } : { status: 'unchanged' };
}

// loginWithPassword 仅供 feature 内部（LoginForm）相对导入使用，不属于模块公开 API；
// 公开出口以 index.ts 为准。
export function loginWithPassword(input: Parameters<typeof executeLoginWithPassword>[0]) {
  return executeLoginWithPassword(input);
}
