// src/pages/restricted/index.spec.tsx
// @vitest-environment jsdom

/**
 * 受限会话落地页装配层单测。
 *
 * 页面只负责：按会话 restriction 展示受限原因、必须改密时复用账号设置改密表单，
 * 以及改密成功后的会话收口（清理会话 + 回登录页）。路由收口语义由
 * auth-session 策略与 route-guards 单测覆盖，这里只验证页面接线。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthSessionIdentity, AuthSessionRestriction } from '@/features/auth-session';

const mocks = vi.hoisted(() => ({
  clearSessionAfterPasswordChangeMock: vi.fn(),
  navigateMock: vi.fn(),
  restriction: { current: 'MUST_CHANGE_PASSWORD' as AuthSessionRestriction },
}));

const INITIATED_IDENTITY: AuthSessionIdentity = { accountId: 900101, epoch: 3 };

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return { ...actual, useNavigate: () => mocks.navigateMock };
});

vi.mock('@/features/auth-session', () => ({
  clearSessionAfterPasswordChange: mocks.clearSessionAfterPasswordChangeMock,
  sampleCurrentAuthSessionIdentity: () => INITIATED_IDENTITY,
  useAuthSession: () => ({
    session: {
      accountId: 900101,
      adminLevel: null,
      customerOrganizationId: null,
      restriction: mocks.restriction.current,
      role: 'ENGINEER',
      userInfo: null,
    },
    status: 'authenticated',
  }),
}));

vi.mock('@/features/account-settings', () => ({
  useAccountSettings: () => ({
    isPending: () => false,
    updatePassword: vi.fn(),
  }),
  ChangePasswordForm: ({
    onSucceeded,
  }: {
    onSucceeded?: (identity: AuthSessionIdentity | null) => boolean | Promise<boolean>;
  }) => (
    <button
      onClick={() => {
        void Promise.resolve(onSucceeded?.(INITIATED_IDENTITY));
      }}
      type="button"
    >
      模拟改密成功
    </button>
  ),
}));

async function renderRestrictedPage() {
  const { RestrictedPage } = await import('./index');

  return render(<RestrictedPage />);
}

describe('RestrictedPage', () => {
  beforeEach(() => {
    mocks.clearSessionAfterPasswordChangeMock.mockReset();
    mocks.navigateMock.mockReset();
    mocks.restriction.current = 'MUST_CHANGE_PASSWORD';
  });

  afterEach(() => {
    cleanup();
  });

  it('必须改密时展示改密表单，改密成功后清理会话并回登录页', async () => {
    mocks.clearSessionAfterPasswordChangeMock.mockResolvedValue(true);
    await renderRestrictedPage();

    expect(screen.getByText('请先修改登录密码')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '模拟改密成功' }));

    await waitFor(() => {
      expect(mocks.clearSessionAfterPasswordChangeMock).toHaveBeenCalledWith(INITIATED_IDENTITY);
      expect(mocks.navigateMock).toHaveBeenCalledWith('/login', { replace: true });
    });
  });

  it('迟到响应不属于当前会话时不清理会话、不跳转', async () => {
    mocks.clearSessionAfterPasswordChangeMock.mockResolvedValue(false);
    await renderRestrictedPage();

    fireEvent.click(screen.getByRole('button', { name: '模拟改密成功' }));

    await waitFor(() => {
      expect(mocks.clearSessionAfterPasswordChangeMock).toHaveBeenCalledWith(INITIATED_IDENTITY);
    });
    expect(mocks.navigateMock).not.toHaveBeenCalled();
  });

  it('工程师待审时只展示原因，不渲染改密表单', async () => {
    mocks.restriction.current = 'ENGINEER_PENDING';
    await renderRestrictedPage();

    expect(screen.getByText('工程师申请审核中')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '模拟改密成功' })).toBeNull();
  });

  it('工程师申请被拒时展示对应原因', async () => {
    mocks.restriction.current = 'ENGINEER_REJECTED';
    await renderRestrictedPage();

    expect(screen.getByText('工程师申请未通过')).toBeInTheDocument();
  });
});
