// src/pages/admin-engineer-approvals/index.spec.tsx
// @vitest-environment jsdom

/**
 * 工程师注册审批页装配层单测：页面只负责页头、布局与把会话等级透传给 feature 面板。
 * 面板自身的读写行为由其 spec 覆盖，这里以桩验证接线。
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminEngineerApprovalsPage } from './index';

const { useAuthSessionMock, PanelStub } = vi.hoisted(() => ({
  useAuthSessionMock: vi.fn(),
  PanelStub: vi.fn(),
}));

vi.mock('@/features/admin-engineer-approval', () => ({
  AdminEngineerApprovalPanel: PanelStub,
}));

vi.mock('@/features/auth-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth-session')>();

  return { ...actual, useAuthSession: () => useAuthSessionMock() };
});

beforeEach(() => {
  useAuthSessionMock.mockReset();
  PanelStub.mockReset().mockImplementation(() => (
    <div data-testid="admin-engineer-approval-panel" />
  ));
});

describe('AdminEngineerApprovalsPage', () => {
  it('渲染页头并组合 feature 公开面板', () => {
    useAuthSessionMock.mockReturnValue({ session: { adminLevel: 1 } });

    render(<AdminEngineerApprovalsPage />);

    expect(screen.getByText('工程师注册审批')).toBeInTheDocument();
    expect(
      screen.getByText('审核工程师注册申请：批准后开通账号与公司成员关系，拒绝时需填写原因。'),
    ).toBeInTheDocument();
    expect(screen.getByText('Engineer Approval')).toBeInTheDocument();
    expect(screen.getByTestId('admin-engineer-approval-panel')).toBeInTheDocument();
  });

  it('把会话等级透传给面板，供其呈现可见范围提示', () => {
    useAuthSessionMock.mockReturnValue({ session: { adminLevel: 2 } });

    render(<AdminEngineerApprovalsPage />);

    expect(PanelStub.mock.calls[0]?.[0]).toMatchObject({ adminLevel: 2 });
  });

  it('会话缺失时以 null 等级降级，不伪造默认管理员权限', () => {
    useAuthSessionMock.mockReturnValue({ session: null });

    render(<AdminEngineerApprovalsPage />);

    expect(PanelStub.mock.calls[0]?.[0]).toMatchObject({ adminLevel: null });
  });
});
