// src/app/layout/app-layout-nickname-sync.spec.tsx
// @vitest-environment jsdom

/**
 * 侧栏昵称同步单测（真实 auth-session 装配）。
 *
 * 与 app-layout.spec.tsx 的分工：那里桩掉 useAuthSession 只看壳层结构；这里走
 * 真实 store + AuthSessionProvider + sessionStorage 持久化，验证昵称窄入口在
 * 壳层显示面的端到端效果：
 * 1. 窄入口更新昵称后，侧栏显示昵称与头像首字立即随之更新（内存发布）；
 * 2. accountId 不匹配的回写被拒绝，侧栏保持原样；
 * 3. 昵称更新同步写入 sessionStorage，模块重载（模拟刷新）后从持久化恢复。
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

// sidecar 是重量级组件（会话/GraphQL 依赖），置空。
vi.mock('@/widgets/aigc-sidecar', () => ({
  AigcSidecar: () => null,
}));

// 本文件走真实 store 装配；只在基础设施边界桩掉启动期身份复核的网络请求，
// 不整体 mock feature 模块 —— 否则 vi.resetModules() 无法重建真实 store，
// 用例之间会共享上一个用例的内存会话。
vi.mock('@/features/auth-session/infrastructure/auth-session-identity-graphql', () => ({
  fetchMySessionIdentity: vi.fn().mockResolvedValue(null),
}));

const STORAGE_KEY = 'lithography-platform.auth-session.v1';

async function renderLayout(pathname: string) {
  const [{ ThemeProvider }, { AuthSessionProvider }, { AppLayout }] = await Promise.all([
    import('@/app/providers'),
    import('@/features/auth-session'),
    import('./app-layout'),
  ]);
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[pathname]}>
        <Routes>
          <Route
            element={
              <AuthSessionProvider>
                <AppLayout>页面内容</AppLayout>
              </AuthSessionProvider>
            }
            path="*"
          />
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

// 测试在模块初始化前写 sessionStorage，再动态导入壳层；不暴露测试专用公共 API。
function establishEngineerSession(nickname: string) {
  window.sessionStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      accessToken: 'sync-access-token',
      accountId: 900201,
      role: 'ENGINEER',
      userInfo: { accessGroup: ['ENGINEER'], nickname },
      version: 2,
    }),
  );
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.resetModules();
});

describe('AppLayout 侧栏昵称同步（真实会话装配）', () => {
  it('窄入口更新昵称后，侧栏显示昵称与头像首字立即更新', async () => {
    establishEngineerSession('陈工');
    await renderLayout('/');

    expect(screen.getByText('陈工')).toBeInTheDocument();
    expect(screen.getByText('陈')).toBeInTheDocument();

    const { updateCurrentAuthSessionNickname } = await import('@/features/auth-session');
    act(() => {
      expect(updateCurrentAuthSessionNickname(900201, ' 林工程师 ')).toBe(true);
    });

    expect(screen.getByText('林工程师')).toBeInTheDocument();
    expect(screen.getByText('林')).toBeInTheDocument();
    expect(screen.queryByText('陈工')).not.toBeInTheDocument();
  }, 15_000);

  it('accountId 不匹配的回写被拒绝，侧栏昵称与头像首字保持原样', async () => {
    establishEngineerSession('陈工');
    await renderLayout('/');

    const { updateCurrentAuthSessionNickname } = await import('@/features/auth-session');
    act(() => {
      expect(updateCurrentAuthSessionNickname(999999, '别人的昵称')).toBe(false);
    });

    expect(screen.getByText('陈工')).toBeInTheDocument();
    expect(screen.getByText('陈')).toBeInTheDocument();
    expect(screen.queryByText('别人的昵称')).not.toBeInTheDocument();
  });

  it('昵称更新同步写入 sessionStorage，模块重载（模拟刷新）后从持久化恢复', async () => {
    establishEngineerSession('陈工');

    const { updateCurrentAuthSessionNickname } = await import('@/features/auth-session');
    act(() => {
      expect(updateCurrentAuthSessionNickname(900201, '同步后的昵称')).toBe(true);
    });

    const stored = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? 'null') as {
      accountId?: number;
      userInfo?: { nickname?: string } | null;
      version?: number;
    };
    expect(stored?.version).toBe(2);
    expect(stored?.accountId).toBe(900201);
    expect(stored?.userInfo?.nickname).toBe('同步后的昵称');

    // 模拟刷新：内存态与模块注册表整体丢弃后重新装配，唯一事实源是 sessionStorage
    vi.resetModules();
    const { getCurrentAuthSession: freshCurrentSession } = await import('@/features/auth-session');

    expect(freshCurrentSession()?.accountId).toBe(900201);
    expect(freshCurrentSession()?.userInfo?.nickname).toBe('同步后的昵称');
    expect(freshCurrentSession()?.accessToken).toBe('sync-access-token');
  });
});
