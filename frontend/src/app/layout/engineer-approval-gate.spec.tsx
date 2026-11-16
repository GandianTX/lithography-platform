// src/app/layout/engineer-approval-gate.spec.tsx
// @vitest-environment jsdom

/**
 * 批准结果门的装配语义（F3）：
 * - 展示事实只来自服务端：mySessionIdentity 确认 NONE + myEngineerRegistration 为 APPROVED；
 * - 检查期间不挂载工作台内容；新浏览器（无本地偏好）也会展示批准结果与真实公司；
 * - localStorage 只记录「已确认这份结果」的展示偏好，缺失只影响展示次数，不影响访问；
 * - 「进入工作台」重新复核同账号同会话代次，stale / 仍受限 / 申请不再通过都不导航；
 * - 无申请的存量工程师、非工程师、仍受限会话沿既有路径直接渲染内容。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthSessionRestriction } from '@/features/auth-session';
import type { MyEngineerRegistrationView } from '@/features/registration';

import {
  acknowledgeEngineerApproval,
  hasAcknowledgedEngineerApproval,
} from './engineer-approval-notice-storage';

const APPROVED_APPLICATION: MyEngineerRegistrationView = {
  applicationId: 9001,
  organizationId: 4401,
  organizationName: '主组织 A',
  status: 'APPROVED',
  applicationNote: '请审核',
  submittedAt: '2026-11-16T00:00:00.000Z',
  reviewedAt: '2026-11-16T01:00:00.000Z',
  reviewComment: null,
};

const mocks = vi.hoisted(() => ({
  session: {
    current: null as {
      accountId: number;
      restriction: AuthSessionRestriction;
      role: string;
    } | null,
  },
  epoch: { current: 1 },
  getCurrentSessionMock: vi.fn(),
  navigateMock: vi.fn(),
  refreshIdentityMock: vi.fn(),
  sampleIdentityMock: vi.fn(),
  fetchRegistrationMock: vi.fn(),
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
    session: mocks.session.current,
    status: mocks.session.current === null ? 'anonymous' : 'authenticated',
  }),
}));

vi.mock('@/features/registration', () => ({
  fetchMyEngineerRegistration: mocks.fetchRegistrationMock,
}));

import { EngineerApprovalGate } from './engineer-approval-gate';

function sessionFor(accountId: number, restriction: AuthSessionRestriction) {
  return { accountId, restriction, role: 'ENGINEER' };
}

function renderGate() {
  return render(
    <EngineerApprovalGate>
      <div>工作台内容</div>
    </EngineerApprovalGate>,
  );
}

describe('EngineerApprovalGate', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.session.current = sessionFor(1, 'NONE');
    mocks.epoch.current = 1;
    mocks.getCurrentSessionMock.mockReset();
    mocks.getCurrentSessionMock.mockImplementation(() => mocks.session.current);
    mocks.navigateMock.mockReset();
    mocks.refreshIdentityMock.mockReset().mockResolvedValue({ status: 'unchanged' });
    mocks.sampleIdentityMock
      .mockReset()
      .mockImplementation(() => ({ accountId: 1, epoch: mocks.epoch.current }));
    mocks.fetchRegistrationMock.mockReset().mockResolvedValue(APPROVED_APPLICATION);
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('新浏览器首次登录已批准账号：先展示批准结果与真实公司，不挂载工作台内容', async () => {
    renderGate();

    await waitFor(() => {
      expect(screen.getByText('申请已通过，权限已开通')).toBeInTheDocument();
    });
    expect(screen.getByText('主组织 A')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '进入工作台' })).toBeInTheDocument();
    expect(screen.queryByText('工作台内容')).toBeNull();
  });

  it('进入工作台：复核成功且资格与申请仍成立时记录展示偏好并导航', async () => {
    renderGate();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '进入工作台' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));

    await waitFor(() => {
      expect(mocks.navigateMock).toHaveBeenCalledWith('/home/ENGINEER', { replace: true });
    });
    expect(screen.getByText('工作台内容')).toBeInTheDocument();
    expect(screen.queryByText('申请已通过，权限已开通')).toBeNull();
  });

  it('已确认过的批准结果刷新后直接进入工作台，不再阻塞', async () => {
    acknowledgeEngineerApproval(1, APPROVED_APPLICATION.applicationId);
    renderGate();

    await waitFor(() => {
      expect(screen.getByText('工作台内容')).toBeInTheDocument();
    });
    expect(screen.queryByText('申请已通过，权限已开通')).toBeNull();
  });

  it('无申请记录的存量工程师沿既有路径直接进入工作台', async () => {
    mocks.fetchRegistrationMock.mockResolvedValue(null);
    renderGate();

    await waitFor(() => {
      expect(screen.getByText('工作台内容')).toBeInTheDocument();
    });
    expect(screen.queryByText('申请已通过，权限已开通')).toBeNull();
  });

  it('申请不是 APPROVED 时不展示批准结果', async () => {
    mocks.fetchRegistrationMock.mockResolvedValue({
      ...APPROVED_APPLICATION,
      status: 'PENDING',
    });
    renderGate();

    await waitFor(() => {
      expect(screen.getByText('工作台内容')).toBeInTheDocument();
    });
    expect(screen.queryByText('申请已通过，权限已开通')).toBeNull();
  });

  it('受限会话与非工程师会话不发起批准检查，直接渲染既有内容', () => {
    mocks.session.current = sessionFor(1, 'ENGINEER_PENDING');
    const pending = renderGate();

    expect(screen.getByText('工作台内容')).toBeInTheDocument();
    expect(mocks.fetchRegistrationMock).not.toHaveBeenCalled();
    pending.unmount();

    mocks.session.current = { accountId: 2, restriction: 'NONE', role: 'CUSTOMER' };
    renderGate();

    expect(screen.getByText('工作台内容')).toBeInTheDocument();
    expect(mocks.fetchRegistrationMock).not.toHaveBeenCalled();
  });

  it('服务端复核返回 stale（迟到 / 被覆盖）时不展示结果', async () => {
    mocks.refreshIdentityMock.mockResolvedValue({ status: 'stale' });
    renderGate();

    await waitFor(() => {
      expect(screen.getByText('工作台内容')).toBeInTheDocument();
    });
    expect(mocks.fetchRegistrationMock).not.toHaveBeenCalled();
  });

  it('申请读取期间会话已切换（会话代次变化）时不展示结果', async () => {
    mocks.fetchRegistrationMock.mockImplementation(async () => {
      mocks.epoch.current = 2;
      return APPROVED_APPLICATION;
    });
    renderGate();

    await waitFor(() => {
      expect(screen.getByText('工作台内容')).toBeInTheDocument();
    });
    expect(screen.queryByText('申请已通过，权限已开通')).toBeNull();
  });

  it('加载失败展示可重试错误态，重试成功后展示批准结果', async () => {
    mocks.fetchRegistrationMock
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(APPROVED_APPLICATION);
    renderGate();

    await waitFor(() => {
      expect(screen.getByText('无法获取审核结果，请稍后重试。')).toBeInTheDocument();
    });
    expect(screen.queryByText('工作台内容')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    await waitFor(() => {
      expect(screen.getByText('申请已通过，权限已开通')).toBeInTheDocument();
    });
  });

  it('进入时复核结果为 stale：不导航、不写展示偏好', async () => {
    mocks.refreshIdentityMock
      .mockResolvedValueOnce({ status: 'unchanged' })
      .mockResolvedValueOnce({ status: 'stale' });
    renderGate();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '进入工作台' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));

    await waitFor(() => {
      expect(screen.getByText('当前会话已变化，请刷新页面或重新登录后重试。')).toBeInTheDocument();
    });
    expect(mocks.navigateMock).not.toHaveBeenCalled();

    // 未写偏好：重新挂载仍会展示结果
    cleanup();
    renderGate();
    await waitFor(() => {
      expect(screen.getByText('申请已通过，权限已开通')).toBeInTheDocument();
    });
  });

  it('进入时服务端已撤销资格：不导航、不写展示偏好', async () => {
    renderGate();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '进入工作台' })).toBeInTheDocument();
    });

    // 点击前资格被撤销：复核把 restriction 写回当前会话（真实环境由 app-layout
    // 收口到受限页，门本身不再渲染结果）
    mocks.refreshIdentityMock.mockImplementationOnce(async () => {
      mocks.session.current = sessionFor(1, 'ENGINEER_INACTIVE');
      return { status: 'applied' as const };
    });

    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));

    await waitFor(() => {
      expect(screen.getByText('工作台内容')).toBeInTheDocument();
    });
    expect(mocks.navigateMock).not.toHaveBeenCalled();
    expect(hasAcknowledgedEngineerApproval(1, APPROVED_APPLICATION.applicationId)).toBe(false);
  });

  it('进入时申请已不再是 APPROVED：不导航', async () => {
    mocks.fetchRegistrationMock
      .mockResolvedValueOnce(APPROVED_APPLICATION)
      .mockResolvedValueOnce({ ...APPROVED_APPLICATION, status: 'REJECTED' });
    renderGate();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '进入工作台' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));

    await waitFor(() => {
      expect(
        screen.getByText('当前身份尚未确认开通，仍保持受限访问，请稍后重试。'),
      ).toBeInTheDocument();
    });
    expect(mocks.navigateMock).not.toHaveBeenCalled();
  });

  it('进入时复核请求失败：不导航并提示校验失败', async () => {
    mocks.refreshIdentityMock
      .mockResolvedValueOnce({ status: 'unchanged' })
      .mockRejectedValueOnce(new Error('network'));
    renderGate();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '进入工作台' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));

    await waitFor(() => {
      expect(screen.getByText('身份校验失败，请稍后重试。')).toBeInTheDocument();
    });
    expect(mocks.navigateMock).not.toHaveBeenCalled();
  });
});
