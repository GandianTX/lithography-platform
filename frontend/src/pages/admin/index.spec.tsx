// src/pages/admin/index.spec.tsx
// @vitest-environment jsdom

/**
 * 管理员工作台装配层单测（S1）：入口可见性只由会话的可信管理范围决定。
 * 范围判定本身由 auth-session 策略单测覆盖，这里验证页面接线与无死链接约束。
 */

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminPage } from './index';

const useAuthSessionMock = vi.fn();

vi.mock('@/features/auth-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth-session')>();

  return {
    ...actual,
    // 会话卡是展示性组件（内部走 Provider 上下文），页面测试只关心入口分支
    AuthSessionPanel: () => <div data-testid="auth-session-panel" />,
    useAuthSession: () => useAuthSessionMock(),
  };
});

function adminSession(adminLevel: number | null, adminOrganizationId: number | null = null) {
  return {
    session: {
      accessToken: 'token',
      accountId: 900307,
      adminLevel,
      adminOrganizationId,
      customerOrganizationId: null,
      engineerOrganizationId: null,
      registrationOrganizationId: null,
      restriction: 'NONE',
      role: 'SUPER_ADMIN',
      userInfo: { accessGroup: ['SUPER_ADMIN'], avatarUrl: null, nickname: '管理员' },
    },
    status: 'authenticated',
  } as const;
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminPage />
    </MemoryRouter>,
  );
}

describe('AdminPage（S1 管理范围）', () => {
  afterEach(() => {
    cleanup();
    useAuthSessionMock.mockReset();
  });

  it('1 级管理员显示两张全域入口卡', () => {
    useAuthSessionMock.mockReturnValue(adminSession(1, 910003));
    renderPage();

    expect(screen.getByRole('button', { name: '进入用户管理' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '进入文档数据库' })).toBeInTheDocument();
    expect(screen.getByTestId('auth-session-panel')).toBeInTheDocument();
  });

  it('2 级管理员不渲染全域入口，说明本公司入口尚未开放', () => {
    useAuthSessionMock.mockReturnValue(adminSession(2, 910004));
    renderPage();

    expect(screen.queryByRole('button', { name: '进入用户管理' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '进入文档数据库' })).not.toBeInTheDocument();
    expect(
      screen.getByText('当前为二级管理员（本公司范围），本公司范围内的管理入口尚未开放。'),
    ).toBeInTheDocument();
  });

  it('缺等级或缺可信组织的管理员不渲染全域入口', () => {
    useAuthSessionMock.mockReturnValue(adminSession(null, 910003));
    const view = renderPage();

    expect(screen.queryByRole('button', { name: '进入用户管理' })).not.toBeInTheDocument();
    expect(
      screen.getByText('当前账号缺少可信的管理等级或组织归属，暂无可用的管理入口。'),
    ).toBeInTheDocument();

    // 1 级但无有效成员组织：服务端同样拒绝组织范围操作，前端不出全域入口
    view.unmount();
    useAuthSessionMock.mockReturnValue(adminSession(1, null));
    renderPage();

    expect(screen.queryByRole('button', { name: '进入用户管理' })).not.toBeInTheDocument();
    expect(
      screen.getByText('当前账号缺少可信的管理等级或组织归属，暂无可用的管理入口。'),
    ).toBeInTheDocument();
  });
});
