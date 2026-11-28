// src/features/auth-session/application/restore-auth-session.ts

import type { RestoreWebSessionResult } from '../infrastructure/auth-web-session-rest';

import type { EstablishAuthSessionInput } from './auth-session.types';

/**
 * 启动恢复结果：
 * - `restored`：服务端确认有会话，且已写入本地会话真源
 * - `absent`：服务端明确无会话/已失效，本地会话已清理
 * - `unavailable`：无法确认（网络/服务/来源配置），本地会话与 Cookie 均未改动
 * - `stale`：结果迟到（期间发生了登录/退出/另一次恢复），已丢弃
 */
export type WebSessionRestoreOutcome = 'restored' | 'absent' | 'unavailable' | 'stale';

export type WebSessionSessionPort = {
  establishSession: (input: EstablishAuthSessionInput) => void;
  clearSession: () => void;
  getSessionEpoch: () => number;
};

/**
 * 恢复结果的「同步或异步」二态返回值。
 *
 * 功能关闭、或结果已记忆时返回同步值：这样关闭本功能时路由守卫与改造前完全一致
 * （同步 loader、零额外请求）；只有真正需要往返服务端时才返回 Promise。
 */
export type MaybeAsyncOutcome = WebSessionRestoreOutcome | Promise<WebSessionRestoreOutcome>;

export type WebSessionRestoreController = {
  /**
   * 共享一次恢复请求：并发调用复用同一个 Promise，成功后记忆结果。
   *
   * `force` 仅用于显式重试（重试页按钮），会发起新请求。
   */
  ensure: (options?: { force?: boolean }) => MaybeAsyncOutcome;
  /**
   * 作废在途恢复（跨页退出、换号等「会话事实已被别处改写」的事件）。
   *
   * 与本地是否有会话无关：本页可能还没完成恢复，旧请求同样不能再落地。
   * 作废后记忆失效、在途 promise 让出位置，下一次 ensure 会用当前 Cookie 重新问服务端。
   */
  invalidatePendingRestore: () => void;
  /** 本地已建立新会话（登录成功）：不再需要恢复 */
  markSessionEstablished: () => void;
  /** 本地会话已被主动清除（退出成功）：后续匿名判定无需再问服务端 */
  markSessionCleared: () => void;
};

export function createWebSessionRestoreController(deps: {
  enabled: boolean;
  gateway: { restore: () => Promise<RestoreWebSessionResult> };
  session: WebSessionSessionPort;
  clearClientCache?: () => void;
}): WebSessionRestoreController {
  let memo: WebSessionRestoreOutcome | null = null;
  let inFlight: Promise<WebSessionRestoreOutcome> | null = null;
  // 只允许最新一次尝试写入会话真源：重试页连点、启动与显式重试并发都靠它收敛
  let sequence = 0;

  /** 本次尝试是否已被更晚的事实作废（代次推进，或期间又发起了别的尝试/事件） */
  function isStale(attempt: number, epochAtStart: number): boolean {
    return deps.session.getSessionEpoch() !== epochAtStart || attempt !== sequence;
  }

  async function run(attempt: number): Promise<WebSessionRestoreOutcome> {
    const epochAtStart = deps.session.getSessionEpoch();

    let result: RestoreWebSessionResult;

    try {
      result = await deps.gateway.restore();
    } catch {
      // 网络失败同样可能是迟到结果：作废的尝试不得把页面导向重试页
      return isStale(attempt, epochAtStart) ? 'stale' : 'unavailable';
    }

    // 迟到结果：期间已登录/退出/另一次恢复推进了代次，或已有更新的尝试
    // 一律丢弃，绝不覆盖当前会话（由调用方按当前状态重新判定）
    if (isStale(attempt, epochAtStart)) {
      return 'stale';
    }

    if (result.status === 'restored') {
      deps.session.establishSession(result.session);

      return 'restored';
    }

    if (result.status === 'absent') {
      // 服务端明确说「没有会话」：必须清掉本页签缓存，不允许以旧令牌继续放行
      deps.clearClientCache?.();
      deps.session.clearSession();

      return 'absent';
    }

    // 无法确认：不动本地会话，交给重试页
    return 'unavailable';
  }

  return {
    ensure(options) {
      // 功能关闭时保持改造前的登录判定：不发起恢复、不改会话（同步返回）
      if (!deps.enabled) {
        return 'restored' satisfies WebSessionRestoreOutcome;
      }

      if (!options?.force && memo) {
        return memo;
      }

      if (inFlight) {
        return inFlight;
      }

      sequence += 1;
      const attempt = sequence;

      const pending: Promise<WebSessionRestoreOutcome> = run(attempt)
        .then((outcome) => {
          // stale 不记忆：下一次 ensure 必须重新问服务端
          if (outcome !== 'stale') {
            memo = outcome;
          }

          return outcome;
        })
        .finally(() => {
          // 只有「当前在途的仍是自己」才让位：被作废的旧请求收尾时
          // 不能把期间新发起的请求状态清掉
          if (inFlight === pending) {
            inFlight = null;
          }
        });

      inFlight = pending;

      return pending;
    },

    invalidatePendingRestore() {
      // 推进尝试序号：在途尝试回来时必然判为 stale
      sequence += 1;
      // 记忆作废：后续判定必须重新问服务端（用当前 Cookie），不能沿用旧结论
      memo = null;
      // 让出在途位置：新调用立即发起新请求（旧 promise 收尾不会清掉它）
      inFlight = null;
    },

    markSessionEstablished() {
      memo = 'restored';
    },

    markSessionCleared() {
      memo = 'absent';
    },
  };
}
