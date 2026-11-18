// src/features/auth-session/ui/auth-session-panel.spec.tsx

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { createTranslator, I18nContext } from '@/shared/i18n';

import { authSessionStore } from '../auth-session-entry';

import { AuthSessionPanel } from './auth-session-panel';
import { AuthSessionProvider } from './auth-session-provider';

function renderPanelRoute() {
  return render(
    <AuthSessionProvider>
      <MemoryRouter initialEntries={['/engineer']}>
        <Routes>
          <Route element={<AuthSessionPanel />} path="/engineer" />
          <Route element={<div>login-page-marker</div>} path="/login" />
        </Routes>
      </MemoryRouter>
    </AuthSessionProvider>,
  );
}

/** 管理员首页「当前账号」卡形态：挂 /admin，并提供账号设置路由承接导航断言。 */
function renderAccountPanelRoute() {
  return render(
    <AuthSessionProvider>
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route element={<AuthSessionPanel variant="account" />} path="/admin" />
          <Route element={<div>account-settings-page-marker</div>} path="/account/settings" />
        </Routes>
      </MemoryRouter>
    </AuthSessionProvider>,
  );
}

/** 英文界面下的账号卡：用 I18nContext 装配最小状态容器（features 层禁止依赖 app 的 Provider）。 */
function renderAccountPanelRouteInEnglish() {
  return render(
    <I18nContext.Provider
      value={{ language: 'en', setLanguage: () => undefined, t: createTranslator('en') }}
    >
      <AuthSessionProvider>
        <MemoryRouter initialEntries={['/admin']}>
          <Routes>
            <Route element={<AuthSessionPanel variant="account" />} path="/admin" />
            <Route element={<div>account-settings-page-marker</div>} path="/account/settings" />
          </Routes>
        </MemoryRouter>
      </AuthSessionProvider>
    </I18nContext.Provider>,
  );
}

describe('AuthSessionPanel', () => {
  afterEach(() => {
    authSessionStore.clearSession();
    window.sessionStorage.clear();
    cleanup();
  });

  it('shows only the safe session view for an authenticated session', () => {
    authSessionStore.establishSession({
      accessToken: 'test-only-access-token',
      accountId: 900101,
      role: 'ENGINEER',
      userInfo: {
        accessGroup: ['ENGINEER'],
        avatarUrl: null,
        nickname: '陈工',
      },
    });

    renderPanelRoute();

    expect(screen.getByText('登录成功')).toBeInTheDocument();
    expect(screen.getByText('900101')).toBeInTheDocument();
    expect(screen.getByText('陈工')).toBeInTheDocument();
    expect(screen.getAllByText('ENGINEER').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /退出登录/ })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('test-only-access-token');
  });

  it('账号卡只提供「账号设置」快捷入口，不再内嵌退出登录，且导航到既有账号设置路由（PR6）', async () => {
    authSessionStore.establishSession({
      accessToken: 'test-only-access-token',
      accountId: 900201,
      role: 'SUPER_ADMIN',
      userInfo: {
        accessGroup: ['SUPER_ADMIN'],
        avatarUrl: null,
        nickname: '系统管理员',
      },
    });

    renderAccountPanelRoute();

    expect(screen.getByRole('heading', { name: '当前账号' })).toBeInTheDocument();
    expect(screen.getByText('账号 ID：900201')).toBeInTheDocument();
    // 卡内不得再出现退出登录：唯一退出入口是侧栏左下角常驻按钮
    expect(screen.queryByRole('button', { name: /退出登录/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /账号设置/ }));

    await waitFor(() => {
      expect(screen.getByText('account-settings-page-marker')).toBeInTheDocument();
    });
    expect(document.body.textContent).not.toContain('test-only-access-token');
  });

  it('账号卡在英文界面下不残留中文文案', () => {
    authSessionStore.establishSession({
      accessToken: 'test-only-access-token',
      accountId: 900301,
      role: 'SUPER_ADMIN',
      userInfo: {
        accessGroup: ['SUPER_ADMIN'],
        avatarUrl: null,
        nickname: 'Admin User',
      },
    });

    renderAccountPanelRouteInEnglish();

    expect(screen.getByRole('heading', { name: 'Current account' })).toBeInTheDocument();
    expect(screen.getByText('Account ID: 900301')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Account settings/ })).toBeInTheDocument();
    // 卡内所有可见文案均为英文，不残留任何汉字
    expect(document.body.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('offers a login entry for anonymous visitors instead of a blank panel', async () => {
    renderPanelRoute();

    expect(screen.getByText('当前会话不可用，请先登录。')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /前往登录/ }));

    await waitFor(() => {
      expect(screen.getByText('login-page-marker')).toBeInTheDocument();
    });
  });
});
