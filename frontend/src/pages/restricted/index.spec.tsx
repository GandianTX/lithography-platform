// src/pages/restricted/index.spec.tsx
// @vitest-environment jsdom

/**
 * 受限会话落地页装配层单测。
 *
 * 页面只负责：按会话 restriction 分流展示——必须改密只给改密能力；其余限制态
 * 只读展示本人申请、维护本人资料与改密；以及改密成功后的会话收口（清理会话 +
 * 回登录页）。路由收口语义由 auth-session 策略与 route-guards 单测覆盖，
 * 这里只验证页面接线。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthSessionIdentity, AuthSessionRestriction } from '@/features/auth-session';
import type { MyEngineerRegistrationView } from '@/features/registration';

const INITIATED_IDENTITY: AuthSessionIdentity = { accountId: 900101, epoch: 3 };

const mocks = vi.hoisted(() => ({
  clearSessionAfterPasswordChangeMock: vi.fn(),
  navigateMock: vi.fn(),
  updateNicknameMock: vi.fn(),
  restriction: { current: 'MUST_CHANGE_PASSWORD' as AuthSessionRestriction },
  application: { current: null as MyEngineerRegistrationView | null },
  accountSettingsEnabled: { current: undefined as boolean | undefined },
}));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return { ...actual, useNavigate: () => mocks.navigateMock };
});

vi.mock('@/features/auth-session', () => ({
  clearSessionAfterPasswordChange: mocks.clearSessionAfterPasswordChangeMock,
  getCurrentAuthSession: () => ({ accountId: 900101, restriction: 'ENGINEER_PENDING' }),
  refreshCurrentAuthSessionIdentity: vi.fn().mockResolvedValue(false),
  sampleCurrentAuthSessionIdentity: () => INITIATED_IDENTITY,
  updateCurrentAuthSessionNickname: mocks.updateNicknameMock,
  useAuthSession: () => ({
    session: {
      accountId: 900101,
      adminLevel: null,
      customerOrganizationId: null,
      engineerOrganizationId: null,
      adminOrganizationId: null,
      registrationOrganizationId: null,
      restriction: mocks.restriction.current,
      role: 'ENGINEER',
      userInfo: null,
    },
    status: 'authenticated',
  }),
}));

vi.mock('@/features/registration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/registration')>();

  return {
    ...actual,
    useMyEngineerRegistration: () => ({
      retry: vi.fn(),
      state: { application: mocks.application.current, status: 'ready' },
    }),
  };
});

vi.mock('@/features/account-settings', () => ({
  useAccountSettings: (options: { enabled?: boolean } = {}) => {
    mocks.accountSettingsEnabled.current = options.enabled;

    return {
      isPending: () => false,
      reload: vi.fn(),
      state: {
        settings: {
          adminLevel: null,
          companyName: null,
          contactEmail: null,
          loginEmail: 'engineer@example.com',
          loginName: 'mock_engineer',
          nickname: '陈工',
          phone: null,
          realName: null,
          role: 'ENGINEER',
          status: 'ACTIVE',
          trustedCompanyName: '测试公司',
          updatedAt: '2026-11-14T10:00:00.000Z',
        },
        status: 'ready',
      },
      updatePassword: vi.fn(),
      updateProfile: vi.fn(),
    };
  },
  AccountProfileForm: ({ mode }: { mode?: string }) => (
    <div data-mode={mode} data-testid="account-profile-form">
      资料维护表单
    </div>
  ),
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
    mocks.updateNicknameMock.mockReset();
    mocks.restriction.current = 'MUST_CHANGE_PASSWORD';
    mocks.application.current = null;
  });

  afterEach(() => {
    cleanup();
  });

  it('必须改密时只展示改密表单，改密成功后清理会话并回登录页', async () => {
    mocks.clearSessionAfterPasswordChangeMock.mockResolvedValue(true);
    await renderRestrictedPage();

    expect(screen.getByText('请先修改登录密码')).toBeInTheDocument();
    expect(screen.queryByText('我的工程师申请')).toBeNull();
    expect(screen.queryByTestId('account-profile-form')).toBeNull();
    // 强制改密态不得加载账号资料
    expect(mocks.accountSettingsEnabled.current).toBe(false);

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

  it('工程师待审时展示申请信息与本人资料维护，不暴露审批写入口', async () => {
    mocks.restriction.current = 'ENGINEER_PENDING';
    mocks.application.current = {
      applicationId: 7001,
      organizationId: 11,
      organizationName: '测试公司',
      status: 'PENDING',
      applicationNote: '希望加入',
      submittedAt: '2026-11-14T10:00:00.000Z',
      reviewedAt: null,
      reviewComment: null,
    };
    await renderRestrictedPage();

    expect(screen.getByText('工程师申请审核中')).toBeInTheDocument();
    expect(screen.getByText('我的工程师申请')).toBeInTheDocument();
    expect(screen.getByText('测试公司')).toBeInTheDocument();
    expect(screen.getByText('审核中')).toBeInTheDocument();
    expect(screen.getByTestId('account-profile-form')).toBeInTheDocument();
    // 非改密限制态才加载资料，且资料表单以受限模式（公司只读、只提交获准字段）渲染
    expect(mocks.accountSettingsEnabled.current).toBe(true);
    expect(screen.getByTestId('account-profile-form')).toHaveAttribute('data-mode', 'restricted');
    expect(screen.getByRole('button', { name: '模拟改密成功' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /批准|拒绝|审核通过/ })).toBeNull();
  });

  it('工程师申请被拒时展示拒绝原因', async () => {
    mocks.restriction.current = 'ENGINEER_REJECTED';
    mocks.application.current = {
      applicationId: 7002,
      organizationId: 11,
      organizationName: '测试公司',
      status: 'REJECTED',
      applicationNote: null,
      submittedAt: '2026-11-14T10:00:00.000Z',
      reviewedAt: '2026-11-14T11:00:00.000Z',
      reviewComment: '资料不完整，请补充后重新提交',
    };
    await renderRestrictedPage();

    expect(screen.getByText('工程师申请未通过')).toBeInTheDocument();
    expect(screen.getByText('已拒绝')).toBeInTheDocument();
    expect(screen.getByText('资料不完整，请补充后重新提交')).toBeInTheDocument();
  });

  it('申请资格尚未生效时展示对应原因', async () => {
    mocks.restriction.current = 'ENGINEER_INACTIVE';
    await renderRestrictedPage();

    expect(screen.getByText('工程师资格尚未生效')).toBeInTheDocument();
  });
});
