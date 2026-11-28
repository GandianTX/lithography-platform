// src/features/auth-session/ui/logout-button.spec.tsx

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageFeedbackProvider } from '@/shared/ui/message-feedback';

import { logoutAuthSessionWithSignOut } from '../auth-session-entry';

import { LogoutButton } from './logout-button';

vi.mock('../auth-session-entry', () => ({
  logoutAuthSessionWithSignOut: vi.fn(),
}));

const mockedLogout = vi.mocked(logoutAuthSessionWithSignOut);

function renderLogoutRoute(iconOnly = false) {
  return render(
    <ConfigProvider>
      <MessageFeedbackProvider>
        <MemoryRouter initialEntries={['/engineer']}>
          <Routes>
            <Route element={<LogoutButton iconOnly={iconOnly} />} path="/engineer" />
            <Route element={<div>login-page-marker</div>} path="/login" />
          </Routes>
        </MemoryRouter>
      </MessageFeedbackProvider>
    </ConfigProvider>,
  );
}

describe('LogoutButton', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('服务端清除成功后清理本地会话并返回登录页', async () => {
    mockedLogout.mockResolvedValue('ok');
    renderLogoutRoute();

    fireEvent.click(screen.getByRole('button', { name: /退出登录/ }));

    await waitFor(() => {
      expect(screen.getByText('login-page-marker')).toBeInTheDocument();
    });
    expect(mockedLogout).toHaveBeenCalledTimes(1);
  });

  it('服务端清除失败时留在原页、提示退出未完成并切换为重试态', async () => {
    mockedLogout.mockResolvedValue('sign-out-failed');
    renderLogoutRoute();

    fireEvent.click(screen.getByRole('button', { name: /退出登录/ }));

    // 不跳转：新标签页仍可能恢复登录，不能假装已退出
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /重试退出/ })).toBeInTheDocument();
    });
    expect(screen.queryByText('login-page-marker')).not.toBeInTheDocument();
    expect(mockedLogout).toHaveBeenCalledTimes(1);
  });

  it('重试态再次点击会重新发起退出', async () => {
    mockedLogout.mockResolvedValueOnce('sign-out-failed').mockResolvedValueOnce('ok');
    renderLogoutRoute();

    fireEvent.click(screen.getByRole('button', { name: /退出登录/ }));
    const retryButton = await screen.findByRole('button', { name: /重试退出/ });
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(screen.getByText('login-page-marker')).toBeInTheDocument();
    });
    expect(mockedLogout).toHaveBeenCalledTimes(2);
  });

  it('缓存清理异常（会话已清理）仍返回登录页', async () => {
    mockedLogout.mockRejectedValue(new Error('clear failed'));
    renderLogoutRoute();

    fireEvent.click(screen.getByRole('button', { name: /退出登录/ }));

    await waitFor(() => {
      expect(screen.getByText('login-page-marker')).toBeInTheDocument();
    });
  });

  it('退出请求在途时屏蔽重复提交', async () => {
    let resolveLogout: (value: 'ok') => void = () => {};
    mockedLogout.mockImplementation(
      () =>
        new Promise<'ok'>((resolve) => {
          resolveLogout = resolve;
        }),
    );
    renderLogoutRoute();

    const logoutButton = screen.getByRole('button', { name: /退出登录/ });
    fireEvent.click(logoutButton);

    await waitFor(() => {
      expect(logoutButton).toHaveClass('ant-btn-loading');
    });
    fireEvent.click(logoutButton);
    expect(mockedLogout).toHaveBeenCalledTimes(1);

    resolveLogout('ok');

    await waitFor(() => {
      expect(screen.getByText('login-page-marker')).toBeInTheDocument();
    });
  });

  it('iconOnly 态：不渲染文字，可访问名称由 aria-label 提供，点击仍走退出链路', async () => {
    mockedLogout.mockResolvedValue('ok');
    renderLogoutRoute(true);

    const iconButton = screen.getByRole('button', { name: '退出登录' });

    expect(iconButton).toHaveTextContent('');
    expect(screen.queryByText('退出登录')).not.toBeInTheDocument();

    fireEvent.click(iconButton);

    await waitFor(() => {
      expect(screen.getByText('login-page-marker')).toBeInTheDocument();
    });
    expect(mockedLogout).toHaveBeenCalledTimes(1);
  });
});
