// src/app/router/route-guards.ts

// 路由守卫与登录后跳转的窄接线：只读取唯一会话事实源并复用
// features/auth-session 的既有策略，不维护第二份会话状态。
// URL 参数解析委托 auth-session 的 URL adapter，守卫只决定何时放行或跳转。
// 拆出独立模块是为了让应用装配层可以被窄范围测试覆盖。
//
// 浏览器会话开启后，三个 loader 在做**首次匿名判定前**共享一次恢复请求：
// - 先 resolve `ensureWebSessionRestored()`，再读会话（不能先跳登录再弹回）；
// - `unavailable`（网络/服务故障）不是「未登录」：去重试页，不清会话；
// - `stale` 表示结果已过期（期间发生了登录/退出/换号）：已登录就按当前会话判定，
//   仍无会话则用当前 Cookie 重新恢复一次（旧在途请求已被作废，不复用它的结果）。
// - 功能关闭时恢复是同步空操作，loader 行为与改造前完全一致（同步、零请求）。
import { redirect } from 'react-router';

import {
  composeProtectedRequestTarget,
  composeSessionUnavailableRedirectPath,
  ensureWebSessionRestored,
  getCurrentAuthSession,
  readAuthReturnToFromRequest,
  resolveEntryRouteRedirect,
  resolveLoginRouteRedirect,
  resolveProtectedRouteRedirect,
  type WebSessionRestoreOutcome,
} from '@/features/auth-session';

type RouteLoaderArgs = {
  request: Request;
};

/**
 * 把「同步或异步的恢复结果」接到统一的判定函数上。
 *
 * 关闭功能时 `ensureWebSessionRestored()` 返回同步值，loader 因此仍是同步的，
 * 既有行为与既有测试零变化；开启且需要往返服务端时才走异步分支。
 *
 * `stale`（结果已过期）的处理：期间已登录就按当前会话判定；否则用当前 Cookie
 * 重新恢复一次（旧的在途请求已被作废），只重试一次，避免与持续作废互相拉锯。
 */
function resolveSessionOutcome<TResult>(
  outcome: WebSessionRestoreOutcome | Promise<WebSessionRestoreOutcome>,
  decide: (resolved: WebSessionRestoreOutcome) => TResult,
  retriesLeft = 1,
): TResult | Promise<TResult> {
  if (outcome instanceof Promise) {
    return outcome.then((resolved) => resolveSessionOutcome(resolved, decide, retriesLeft));
  }

  if (outcome !== 'stale') {
    return decide(outcome);
  }

  if (getCurrentAuthSession()) {
    return decide('restored');
  }

  if (retriesLeft <= 0) {
    return decide('absent');
  }

  return resolveSessionOutcome(ensureWebSessionRestored(), decide, retriesLeft - 1);
}

// 入口路由恒跳转，去向决策委托策略层唯一的 resolveEntryRouteRedirect：
// 未登录去 /login，已登录按角色去默认入口。
export function indexRouteLoader() {
  return resolveSessionOutcome(ensureWebSessionRestored(), (outcome) => {
    if (outcome === 'unavailable') {
      return redirect(composeSessionUnavailableRedirectPath(null));
    }

    return redirect(resolveEntryRouteRedirect(getCurrentAuthSession()));
  });
}

export function loginLoader({ request }: RouteLoaderArgs) {
  return resolveSessionOutcome(ensureWebSessionRestored(), (outcome) => {
    // 登录页本身不因恢复失败而阻断：用户仍可重新登录（登录成功会重新建立会话），
    // 恢复失败只在受保护路由上构成「暂时无法恢复登录」。
    if (outcome === 'unavailable') {
      return null;
    }

    const loginRedirectPath = resolveLoginRouteRedirect(
      getCurrentAuthSession(),
      readAuthReturnToFromRequest(request),
    );

    return loginRedirectPath ? redirect(loginRedirectPath) : null;
  });
}

export function protectedRouteLoader({ request }: RouteLoaderArgs) {
  const requestedTarget = composeProtectedRequestTarget(request);

  return resolveSessionOutcome(ensureWebSessionRestored(), (outcome) => {
    // 无法确认会话（网络/服务/来源配置）：保留安全 returnTo 去重试页，绝不当成未登录
    if (outcome === 'unavailable') {
      return redirect(composeSessionUnavailableRedirectPath(requestedTarget));
    }

    const protectedRedirectPath = resolveProtectedRouteRedirect(
      getCurrentAuthSession(),
      requestedTarget,
    );

    return protectedRedirectPath ? redirect(protectedRedirectPath) : null;
  });
}
