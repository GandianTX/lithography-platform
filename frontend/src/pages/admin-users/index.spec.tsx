// src/pages/admin-users/index.spec.tsx
// @vitest-environment jsdom

/**
 * 用户管理页装配层单测：页面只负责页头、布局与把会话等级透传给 feature 面板。
 * 面板自身的读写行为由其 spec 覆盖，这里以桩验证接线。
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminUsersPage } from './index';

const { useAuthSessionMock, PanelStub } = vi.hoisted(() => ({
  useAuthSessionMock: vi.fn(),
  PanelStub: vi.fn(),
}));

vi.mock('@/features/admin-user-management', () => ({
  AdminUserManagementPanel: PanelStub,
}));

vi.mock('@/features/auth-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth-session')>();

  return { ...actual, useAuthSession: () => useAuthSessionMock() };
});

beforeEach(() => {
  useAuthSessionMock.mockReset();
  PanelStub.mockReset().mockImplementation(() => <div data-testid="admin-user-management-panel" />);
});

describe('AdminUsersPage', () => {
  it('渲染页头并组合 feature 公开的用户管理面板', () => {
    useAuthSessionMock.mockReturnValue({ session: { adminLevel: 1 } });

    render(<AdminUsersPage />);

    expect(screen.getByText('用户管理')).toBeInTheDocument();
    expect(
      screen.getByText('查看范围内普通用户账号，按需启用、停用或重置为默认密码。'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('admin-user-management-panel')).toBeInTheDocument();
  });

  it('把会话等级透传给面板，供其呈现可见范围提示', () => {
    useAuthSessionMock.mockReturnValue({ session: { adminLevel: 2 } });

    render(<AdminUsersPage />);

    expect(PanelStub.mock.calls[0]?.[0]).toMatchObject({ adminLevel: 2 });
  });

  it('会话缺失时以 null 等级降级，不伪造默认管理员权限', () => {
    useAuthSessionMock.mockReturnValue({ session: null });

    render(<AdminUsersPage />);

    expect(PanelStub.mock.calls[0]?.[0]).toMatchObject({ adminLevel: null });
  });
});
