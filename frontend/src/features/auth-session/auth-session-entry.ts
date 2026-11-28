// src/features/auth-session/auth-session-entry.ts

import { isWebSessionEnabled } from '@/shared/env';

import type { AuthSessionIdentity } from './application/auth-session.types';
import {
  authSessionChannel,
  type AuthSessionChannelEvent,
} from './application/auth-session-channel';
import { createAuthSessionStore } from './application/auth-session-store';
import { createLoginWithPasswordUsecase } from './application/login-with-password';
import {
  createClearSessionAfterPasswordChangeUsecase,
  createLogoutAuthSessionUsecase,
  type LogoutAuthSessionOutcome,
} from './application/logout-auth-session';
import { createWebSessionRestoreController } from './application/restore-auth-session';
import { apolloAuthSessionCache } from './infrastructure/apollo-session-cache';
import { graphQLAuthLoginGateway } from './infrastructure/auth-login-graphql';
import { restAuthLoginGateway } from './infrastructure/auth-login-rest';
import { fetchMySessionIdentity } from './infrastructure/auth-session-identity-graphql';
import { browserAuthSessionPersistence } from './infrastructure/auth-session-storage';
import { restWebSessionGateway } from './infrastructure/auth-web-session-rest';

export const webSessionEnabled = isWebSessionEnabled();

export const authSessionStore = createAuthSessionStore(browserAuthSessionPersistence);

/**
 * 登录网关：
 * - 功能开启 → 同源 REST（服务端同时下发 HttpOnly Cookie，供新标签页恢复）
 * - 功能关闭 → 既有 GraphQL 入口，行为与改造前完全一致
 *
 * 前后端开关不一致时不做自动降级：登录会显式失败（400/404/403），
 * 避免线上同时存在两套互相冲突的凭据判断。
 */
const authLoginGateway = webSessionEnabled ? restAuthLoginGateway : graphQLAuthLoginGateway;

const executeLoginWithPassword = createLoginWithPasswordUsecase({
  gateway: authLoginGateway,
  session: authSessionStore,
});

/**
 * 主动退出：功能开启时先请服务端清除浏览器 Cookie，成功后才清本地。
 * 功能关闭时退化为纯本地清理（既有行为）。
 */
export const logoutAuthSession = createLogoutAuthSessionUsecase({
  cache: apolloAuthSessionCache,
  session: authSessionStore,
  ...(webSessionEnabled ? { signOut: restWebSessionGateway } : {}),
});

export const clearSessionAfterPasswordChange = createClearSessionAfterPasswordChangeUsecase({
  cache: apolloAuthSessionCache,
  session: authSessionStore,
});

/**
 * 仅本地清理（不清服务端 Cookie）。
 *
 * 专供「业务请求 401 宣布会话失效」链路：401 只说明某个令牌失效，
 * 不能因此清掉浏览器里可能已被新登录写入的 Cookie。
 */
export const clearAuthSessionLocally = createLogoutAuthSessionUsecase({
  cache: apolloAuthSessionCache,
  session: authSessionStore,
});

/** 启动恢复控制器（功能关闭时是空操作，等价于改造前的行为） */
export const restoreController = createWebSessionRestoreController({
  enabled: webSessionEnabled,
  gateway: restWebSessionGateway,
  session: authSessionStore,
  clearClientCache: () => apolloAuthSessionCache.clearCache(),
});

/** 共享一次启动恢复：路由守卫在做首次匿名判定前必须 await 它 */
export const ensureWebSessionRestored = restoreController.ensure;

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
export async function loginWithPassword(input: Parameters<typeof executeLoginWithPassword>[0]) {
  const view = await executeLoginWithPassword(input);

  // 新会话已建立：后续匿名判定不需要再问服务端
  restoreController.markSessionEstablished();

  // 通知其他标签页：共享 Cookie 已指向新会话，旧身份视图必须丢弃（只传事件）。
  // 跨标签同步是本功能新增行为：功能关闭时不发布事件，保持标签页独立。
  if (webSessionEnabled) {
    authSessionChannel.publish({ type: 'session-replaced', accountId: view.accountId });
  }

  return view;
}

/**
 * 主动退出（用户点「退出登录」）。
 *
 * 先确认服务端 Cookie 清除成功，再清本地与缓存；失败时保留本地会话并返回
 * `sign-out-failed`，由 UI 提示「退出未完成」并提供重试——绝不把「本地已清空」
 * 说成「所有标签页都已退出」。
 */
export async function logoutAuthSessionWithSignOut(): Promise<LogoutAuthSessionOutcome> {
  const outcome = await logoutAuthSession();

  if (outcome === 'ok') {
    restoreController.markSessionCleared();

    // 退出事件发布与功能开关联动：关闭时不广播，保持标签页独立。
    if (webSessionEnabled) {
      authSessionChannel.publish({ type: 'logout' });
    }
  }

  return outcome;
}

/** 其他标签页的会话事件：只做本地清理，不调用服务端、不接触凭据 */
export async function applyCrossTabSessionEvent(event: AuthSessionChannelEvent): Promise<boolean> {
  // 跨标签事件处理是本功能新增行为：功能关闭时整体失效。即使处理函数被直接
  // 调用，也不得清理本页会话、不得改动恢复状态（保持标签页独立行为）。
  if (!webSessionEnabled) {
    return false;
  }

  const current = getCurrentAuthSession();

  // 本页还没有会话（启动恢复在途）：事件之前发起的恢复同样必须失效，
  // 否则旧响应会把本页登回已退出/已换掉的旧账号
  if (!current) {
    restoreController.invalidatePendingRestore();

    if (event.type === 'logout') {
      // 共享 Cookie 已被清除：本页无需再问服务端
      restoreController.markSessionCleared();
    }

    // 没有可清理的本地会话，不需要触发「回登录页」的整页跳转
    return false;
  }

  // 同账号在新标签重登：共享 Cookie 已指向同一账号的新会话，本页旧令牌仍在
  // 服务端有效，不打断本页操作（由下一次恢复或失效链路自然收敛）
  if (event.type === 'session-replaced' && event.accountId === current.accountId) {
    return false;
  }

  await clearAuthSessionLocally();
  restoreController.invalidatePendingRestore();
  restoreController.markSessionCleared();

  return true;
}

/**
 * 启动跨标签同步（`main.tsx` 在渲染前调用一次）。
 *
 * 返回取消订阅函数；事件体不含任何凭据，只有 `logout` / `session-replaced`。
 */
export function startAuthSessionCrossTabSync(): () => void {
  // 功能关闭时不建立跨标签通道：不订阅、不监听、不处理（也不创建
  // BroadcastChannel），保持改造前基于 sessionStorage 的标签页独立行为。
  if (!webSessionEnabled) {
    return () => undefined;
  }

  return authSessionChannel.subscribe((event) => {
    void applyCrossTabSessionEvent(event).then((changed) => {
      if (!changed) return;

      const returnTo = `${window.location.pathname}${window.location.search}`;
      const target = returnTo.startsWith('/login')
        ? '/login'
        : `/login?returnTo=${encodeURIComponent(returnTo)}`;

      window.location.assign(target);
    });
  });
}

export type { LogoutAuthSessionOutcome } from './application/logout-auth-session';
export type { WebSessionRestoreOutcome } from './application/restore-auth-session';
