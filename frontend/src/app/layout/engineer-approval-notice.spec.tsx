// src/app/layout/engineer-approval-notice.spec.tsx
// @vitest-environment jsdom

/**
 * 一次性批准提示的装配语义：
 * - 受限态按账号写标记，资格生效（服务端确认 NONE）后提示一次；
 * - 关闭 / 进入工作台清除标记，刷新或退出重登仍能读到未消费的标记；
 * - 「进入工作台」前再次复核身份，失败或仍受限时不导航。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthSessionRestriction } from '@/features/auth-session';

import {
  clearPendingEngineerApproval,
  hasPendingEngineerApproval,
  markEngineerApprovalPending,
} from './engineer-approval-notice-storage';

const mocks = vi.hoisted(() => ({
  currentSession: {
    current: null as {
      accountId: number;
      restriction: AuthSessionRestriction;
      role: string;
    } | null,
  },
  getCurrentSessionMock: vi.fn(),
  navigateMock: vi.fn(),
  refreshIdentityMock: vi.fn(),
  sampleIdentityMock: vi.fn(),
}));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return { ...actual, useNavigate: () => mocks.navigateMock };
});

vi.mock('@/features/auth-session', () => ({
  getCurrentAuthSession: mocks.getCurrentSessionMock,
  refreshCurrentAuthSessionIdentity: mocks.refreshIdentityMock,
  resolveAuthSessionHomePath: (role: string) => `/home/${role}`,
  sampleCurrentAuthSessionIdentity: mocks.sampleIdentityMock,
  useAuthSession: () => ({
    session: mocks.currentSession.current,
    status: mocks.currentSession.current === null ? 'anonymous' : 'authenticated',
  }),
}));

import { EngineerApprovalNotice } from './engineer-approval-notice';

function sessionFor(accountId: number, restriction: AuthSessionRestriction) {
  return { accountId, restriction, role: 'ENGINEER' };
}

describe('EngineerApprovalNotice', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.currentSession.current = sessionFor(1, 'ENGINEER_PENDING');
    mocks.getCurrentSessionMock.mockReset();
    mocks.navigateMock.mockReset();
    mocks.refreshIdentityMock.mockReset().mockResolvedValue(false);
    mocks.sampleIdentityMock.mockReset().mockReturnValue({ accountId: 1, epoch: 1 });
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('受限态按账号写入一次性标记，但不在受限页展示', () => {
    render(<EngineerApprovalNotice />);

    expect(hasPendingEngineerApproval(1)).toBe(true);
    expect(screen.queryByText('申请已通过，权限已开通')).toBeNull();
  });

  it('同一账号会话变为 NONE 且有标记时展示提示', () => {
    markEngineerApprovalPending(1);
    mocks.currentSession.current = sessionFor(1, 'NONE');

    render(<EngineerApprovalNotice />);

    expect(screen.getByText('申请已通过，权限已开通')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '进入工作台' })).toBeInTheDocument();
  });

  it('没有标记时不展示（不把 NONE 单独当作批准提示依据）', () => {
    mocks.currentSession.current = sessionFor(1, 'NONE');

    render(<EngineerApprovalNotice />);

    expect(screen.queryByText('申请已通过，权限已开通')).toBeNull();
  });

  it('标记按账号隔离，其他账号登录不串提示', () => {
    markEngineerApprovalPending(2);
    mocks.currentSession.current = sessionFor(1, 'NONE');

    render(<EngineerApprovalNotice />);

    expect(screen.queryByText('申请已通过，权限已开通')).toBeNull();
    expect(hasPendingEngineerApproval(2)).toBe(true);
  });

  it('受限 → NONE 的同一次挂载内会提示（覆盖当前标签内的资格变化）', () => {
    const view = render(<EngineerApprovalNotice />);

    mocks.currentSession.current = sessionFor(1, 'NONE');
    view.rerender(<EngineerApprovalNotice />);

    expect(screen.getByText('申请已通过，权限已开通')).toBeInTheDocument();
  });

  it('未消费的标记在重新挂载后仍提示（覆盖刷新与退出重登）', () => {
    markEngineerApprovalPending(1);
    mocks.currentSession.current = sessionFor(1, 'NONE');

    const view = render(<EngineerApprovalNotice />);
    expect(screen.getByText('申请已通过，权限已开通')).toBeInTheDocument();

    view.unmount();
    render(<EngineerApprovalNotice />);
    expect(screen.getByText('申请已通过，权限已开通')).toBeInTheDocument();
  });

  it('关闭提示会清除标记，之后不再出现', () => {
    markEngineerApprovalPending(1);
    mocks.currentSession.current = sessionFor(1, 'NONE');
    const view = render(<EngineerApprovalNotice />);

    const closeButton = view.container.querySelector('.ant-alert-close-icon');
    expect(closeButton).not.toBeNull();
    fireEvent.click(closeButton as Element);

    expect(screen.queryByText('申请已通过，权限已开通')).toBeNull();
    expect(hasPendingEngineerApproval(1)).toBe(false);
  });

  it('关闭后再次受限并恢复，标记重新写入时仍会再提示（关闭不永久压制同账号）', () => {
    const view = render(<EngineerApprovalNotice />);

    mocks.currentSession.current = sessionFor(1, 'NONE');
    view.rerender(<EngineerApprovalNotice />);
    fireEvent.click(view.container.querySelector('.ant-alert-close-icon') as Element);
    expect(screen.queryByText('申请已通过，权限已开通')).toBeNull();

    // 资格再次被撤销：受限态重新落标记；恢复 NONE 后应再次提示
    mocks.currentSession.current = sessionFor(1, 'ENGINEER_INACTIVE');
    view.rerender(<EngineerApprovalNotice />);
    expect(hasPendingEngineerApproval(1)).toBe(true);

    mocks.currentSession.current = sessionFor(1, 'NONE');
    view.rerender(<EngineerApprovalNotice />);
    expect(screen.getByText('申请已通过，权限已开通')).toBeInTheDocument();
  });

  it('进入工作台前复核身份，确认 NONE 后清标记并跳转角色主页', async () => {
    markEngineerApprovalPending(1);
    mocks.currentSession.current = sessionFor(1, 'NONE');
    mocks.getCurrentSessionMock.mockReturnValue(mocks.currentSession.current);
    render(<EngineerApprovalNotice />);

    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));

    await waitFor(() => {
      expect(mocks.refreshIdentityMock).toHaveBeenCalledTimes(1);
      expect(mocks.navigateMock).toHaveBeenCalledWith('/home/ENGINEER', { replace: true });
    });
    expect(hasPendingEngineerApproval(1)).toBe(false);
  });

  it('复核后仍受限时不导航，标记保留并提示保留', async () => {
    markEngineerApprovalPending(1);
    mocks.currentSession.current = sessionFor(1, 'NONE');
    mocks.getCurrentSessionMock.mockReturnValue(sessionFor(1, 'ENGINEER_INACTIVE'));
    render(<EngineerApprovalNotice />);

    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));

    await waitFor(() => {
      expect(
        screen.getByText('当前身份尚未确认开通，仍保持受限访问，请稍后重试。'),
      ).toBeInTheDocument();
    });
    expect(mocks.navigateMock).not.toHaveBeenCalled();
    expect(hasPendingEngineerApproval(1)).toBe(true);
  });

  it('复核请求失败时不导航，标记保留', async () => {
    markEngineerApprovalPending(1);
    mocks.currentSession.current = sessionFor(1, 'NONE');
    mocks.refreshIdentityMock.mockRejectedValueOnce(new Error('network'));
    render(<EngineerApprovalNotice />);

    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));

    await waitFor(() => {
      expect(screen.getByText('身份校验失败，请稍后重试。')).toBeInTheDocument();
    });
    expect(mocks.navigateMock).not.toHaveBeenCalled();
    expect(hasPendingEngineerApproval(1)).toBe(true);
  });

  it('复核期间会话已切换账号时不导航', async () => {
    markEngineerApprovalPending(1);
    mocks.currentSession.current = sessionFor(1, 'NONE');
    mocks.getCurrentSessionMock.mockReturnValue(sessionFor(2, 'NONE'));
    render(<EngineerApprovalNotice />);

    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));

    await waitFor(() => {
      expect(
        screen.getByText('当前身份尚未确认开通，仍保持受限访问，请稍后重试。'),
      ).toBeInTheDocument();
    });
    expect(mocks.navigateMock).not.toHaveBeenCalled();
    expect(hasPendingEngineerApproval(1)).toBe(true);
  });

  it('清理标记的入口可独立调用（避免脏标记长期残留）', () => {
    markEngineerApprovalPending(1);
    clearPendingEngineerApproval(1);

    expect(hasPendingEngineerApproval(1)).toBe(false);
  });
});
