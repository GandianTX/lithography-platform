// src/app/router/route-guards.restore.spec.ts

// 启动恢复在装配层的窄范围测试：钉住 route-guards.ts 头部四条约束——
// 首次匿名判定前先恢复、`unavailable` 不当未登录（去重试页并保留安全 returnTo）、
// `stale` 按当前会话重新判定、功能关闭时 loader 仍是同步空操作。
//
// 恢复控制器自身的去重/记忆/代次裁决在 features/auth-session 内单独成立，
// 这里只替身它的返回值，验证守卫「怎么用这个结果」。
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthSessionRestriction, AuthSessionRole } from '@/features/auth-session';
import * as authSessionFeature from '@/features/auth-session';

import { indexRouteLoader, loginLoader, protectedRouteLoader } from './route-guards';

vi.mock('@/features/auth-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth-session')>();

  return {
    ...actual,
    ensureWebSessionRestored: vi.fn(),
    getCurrentAuthSession: vi.fn(),
  };
});

const mockedEnsureWebSessionRestored = vi.mocked(authSessionFeature.ensureWebSessionRestored);
const mockedGetCurrentAuthSession = vi.mocked(authSessionFeature.getCurrentAuthSession);

function createSession(role: AuthSessionRole, restriction: AuthSessionRestriction = 'NONE') {
  return {
    accessToken: 'access-token',
    accountId: 900101,
    adminLevel: null,
    customerOrganizationId: null,
    engineerOrganizationId: null,
    adminOrganizationId: null,
    registrationOrganizationId: null,
    restriction,
    role,
    userInfo: null,
  };
}

function createLoaderRequest(url: string) {
  return {
    request: new Request(url),
  };
}

function redirectLocation(result: unknown): string | null {
  return result instanceof Response ? result.headers.get('Location') : null;
}

describe('功能关闭：恢复是同步空操作，loader 行为与改造前一致', () => {
  beforeEach(() => {
    mockedEnsureWebSessionRestored.mockReset();
    mockedGetCurrentAuthSession.mockReset();
    // 未开启浏览器会话时控制器同步返回，请求数为零（此处以「无参调用 + 同步返回」体现）
    mockedEnsureWebSessionRestored.mockReturnValue('restored');
  });

  it('三个 loader 都同步返回，不产生 Promise', () => {
    mockedGetCurrentAuthSession.mockReturnValue(null);

    expect(indexRouteLoader()).toBeInstanceOf(Response);
    expect(protectedRouteLoader(createLoaderRequest('http://localhost/admin'))).toBeInstanceOf(
      Response,
    );
    expect(loginLoader(createLoaderRequest('http://localhost/login'))).toBeNull();
    expect(mockedEnsureWebSessionRestored).toHaveBeenCalledTimes(3);
    expect(mockedEnsureWebSessionRestored).toHaveBeenCalledWith();
  });

  it('匿名与已登录的既有判定不变', () => {
    mockedGetCurrentAuthSession.mockReturnValue(null);
    expect(redirectLocation(indexRouteLoader())).toBe('/login');

    mockedGetCurrentAuthSession.mockReturnValue(createSession('ENGINEER'));
    expect(redirectLocation(indexRouteLoader())).toBe('/engineer');
    expect(protectedRouteLoader(createLoaderRequest('http://localhost/engineer'))).toBeNull();
    expect(
      redirectLocation(
        protectedRouteLoader(createLoaderRequest('http://localhost/customer/repair-requests/1')),
      ),
    ).toBe('/engineer');
  });
});

describe('恢复无法确认（unavailable）：去重试页，不当未登录', () => {
  beforeEach(() => {
    mockedEnsureWebSessionRestored.mockReset();
    mockedGetCurrentAuthSession.mockReset();
    // 即使本地还有会话缓存，也不能据此放行；更不能不成立地宣布未登录
    mockedGetCurrentAuthSession.mockReturnValue(createSession('ENGINEER'));
    mockedEnsureWebSessionRestored.mockReturnValue('unavailable');
  });

  it('受保护路由带安全 returnTo 去重试页，而不是登录页', () => {
    const location = redirectLocation(
      protectedRouteLoader(createLoaderRequest('http://localhost/engineer?tab=open')),
    );

    expect(location).toBe('/session-unavailable?returnTo=%2Fengineer%3Ftab%3Dopen');
  });

  it('受保护路由的 returnTo 只携带路径与查询串（不含 origin）', () => {
    expect(
      redirectLocation(protectedRouteLoader(createLoaderRequest('http://localhost/admin'))),
    ).toBe('/session-unavailable?returnTo=%2Fadmin');
  });

  it('入口路由去重试页且不伪造 returnTo', () => {
    expect(redirectLocation(indexRouteLoader())).toBe('/session-unavailable');
  });

  it('登录页不被阻断：用户仍可重新登录', () => {
    expect(loginLoader(createLoaderRequest('http://localhost/login'))).toBeNull();
  });

  it('恢复结果异步返回时同样生效', async () => {
    mockedEnsureWebSessionRestored.mockReturnValue(Promise.resolve('unavailable'));

    const pending = protectedRouteLoader(createLoaderRequest('http://localhost/engineer'));

    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toBeInstanceOf(Response);
    expect(redirectLocation(await pending)).toBe('/session-unavailable?returnTo=%2Fengineer');
  });
});

describe('恢复结果过期（stale）：按当前会话重新判定', () => {
  beforeEach(() => {
    mockedEnsureWebSessionRestored.mockReset();
    mockedGetCurrentAuthSession.mockReset();
    mockedEnsureWebSessionRestored.mockReturnValue('stale');
  });

  it('期间已退出：受保护路由按未登录处理', () => {
    mockedGetCurrentAuthSession.mockReturnValue(null);

    expect(
      redirectLocation(protectedRouteLoader(createLoaderRequest('http://localhost/admin'))),
    ).toBe('/login?returnTo=%2Fadmin');
  });

  it('期间已登录：受保护路由与本角色放行，跨角色仍收回主页', () => {
    mockedGetCurrentAuthSession.mockReturnValue(createSession('ENGINEER'));

    expect(protectedRouteLoader(createLoaderRequest('http://localhost/engineer'))).toBeNull();
    expect(
      redirectLocation(protectedRouteLoader(createLoaderRequest('http://localhost/admin'))),
    ).toBe('/engineer');
    expect(redirectLocation(indexRouteLoader())).toBe('/engineer');
  });

  it('过期的失败结果不算故障：已登录时不进重试页', () => {
    mockedGetCurrentAuthSession.mockReturnValue(createSession('CUSTOMER'));

    expect(protectedRouteLoader(createLoaderRequest('http://localhost/customer'))).toBeNull();
  });

  it('过期的结果不会把人送去登录页：改按当前 Cookie 重新恢复一次', async () => {
    mockedGetCurrentAuthSession.mockReturnValue(null);
    // 旧恢复被跨页事件作废（stale），随后用当前 Cookie 重发一次并拿到新账号
    mockedEnsureWebSessionRestored.mockReturnValueOnce(Promise.resolve('stale'));
    mockedEnsureWebSessionRestored.mockImplementationOnce(() => {
      mockedGetCurrentAuthSession.mockReturnValue(createSession('CUSTOMER'));

      return Promise.resolve('restored');
    });

    const pending = protectedRouteLoader(createLoaderRequest('http://localhost/customer/orders'));

    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toBeNull();
    expect(mockedEnsureWebSessionRestored).toHaveBeenCalledTimes(2);
  });

  it('重新恢复后仍然没有会话时，才按未登录处理', async () => {
    mockedGetCurrentAuthSession.mockReturnValue(null);
    mockedEnsureWebSessionRestored.mockReturnValue(Promise.resolve('stale'));

    const pending = protectedRouteLoader(createLoaderRequest('http://localhost/admin'));

    await expect(pending).resolves.toBeInstanceOf(Response);
    expect(redirectLocation(await pending)).toBe('/login?returnTo=%2Fadmin');
    // 只重试一次，避免与持续作废互相拉锯
    expect(mockedEnsureWebSessionRestored).toHaveBeenCalledTimes(2);
  });
});
