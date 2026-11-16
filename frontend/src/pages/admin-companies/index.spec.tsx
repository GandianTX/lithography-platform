// src/pages/admin-companies/index.spec.tsx
// @vitest-environment jsdom

/**
 * 公司档案页装配层单测：页面只负责页头、布局与把会话等级透传给 feature 面板。
 * 面板自身的读写行为由其 spec 覆盖，这里以桩验证接线。
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminCompaniesPage } from './index';

const { useAuthSessionMock, PanelStub } = vi.hoisted(() => ({
  useAuthSessionMock: vi.fn(),
  PanelStub: vi.fn(),
}));

vi.mock('@/features/admin-company-management', () => ({
  AdminCompanyManagementPanel: PanelStub,
}));

vi.mock('@/features/auth-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth-session')>();

  return { ...actual, useAuthSession: () => useAuthSessionMock() };
});

beforeEach(() => {
  useAuthSessionMock.mockReset();
  PanelStub.mockReset().mockImplementation(() => <div data-testid="admin-company-panel" />);
});

describe('AdminCompaniesPage', () => {
  it('渲染页头并组合 feature 公开面板', () => {
    useAuthSessionMock.mockReturnValue({ session: { adminLevel: 1 } });

    render(<AdminCompaniesPage />);

    expect(screen.getByText('公司档案')).toBeInTheDocument();
    expect(screen.getByText('维护公司档案、启用状态与维修服务资格。')).toBeInTheDocument();
    expect(screen.getByText('Company Management')).toBeInTheDocument();
    expect(screen.getByTestId('admin-company-panel')).toBeInTheDocument();
  });

  it('把会话等级透传给面板，供其选择读入口与写入口', () => {
    useAuthSessionMock.mockReturnValue({ session: { adminLevel: 2 } });

    render(<AdminCompaniesPage />);

    expect(PanelStub.mock.calls[0]?.[0]).toMatchObject({ adminLevel: 2 });
  });

  it('会话缺失时以 null 等级降级，不伪造默认管理员权限', () => {
    useAuthSessionMock.mockReturnValue({ session: null });

    render(<AdminCompaniesPage />);

    expect(PanelStub.mock.calls[0]?.[0]).toMatchObject({ adminLevel: null });
  });
});
