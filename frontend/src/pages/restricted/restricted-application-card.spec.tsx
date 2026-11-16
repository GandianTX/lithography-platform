// src/pages/restricted/restricted-application-card.spec.tsx
// @vitest-environment jsdom

/**
 * 受限页「我的工程师申请」卡片：显式刷新的接线语义。
 *
 * 刷新必须先做 Session 身份复核，由服务端结果决定是否还需要重查申请；
 * 资格刚生效时不重复发起受限查询，交给布局收口跳转。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthSessionRestriction } from '@/features/auth-session';
import type { MyEngineerRegistrationState } from '@/features/registration';

const mocks = vi.hoisted(() => ({
  currentRestriction: { current: 'ENGINEER_PENDING' as AuthSessionRestriction },
  identityRefreshMock: vi.fn(),
  refreshMock: vi.fn(),
  retryMock: vi.fn(),
  state: { current: undefined as unknown as MyEngineerRegistrationState },
}));

vi.mock('@/features/auth-session', () => ({
  getCurrentAuthSession: () =>
    mocks.currentRestriction.current === null
      ? null
      : { accountId: 900101, restriction: mocks.currentRestriction.current },
  refreshCurrentAuthSessionIdentity: mocks.identityRefreshMock,
}));

vi.mock('@/features/registration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/registration')>();

  return {
    ...actual,
    useMyEngineerRegistration: () => ({
      refresh: mocks.refreshMock,
      retry: mocks.retryMock,
      state: mocks.state.current,
    }),
  };
});

import { RestrictedApplicationCard } from './restricted-application-card';

const READY_STATE: MyEngineerRegistrationState = {
  application: {
    applicationId: 7001,
    organizationId: 11,
    organizationName: '测试公司',
    status: 'PENDING',
    applicationNote: '希望加入',
    submittedAt: '2026-11-14T10:00:00.000Z',
    reviewedAt: null,
    reviewComment: null,
  },
  status: 'ready',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, reject, resolve };
}

async function clickRefresh() {
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }));
}

describe('RestrictedApplicationCard 显式刷新', () => {
  beforeEach(() => {
    mocks.currentRestriction.current = 'ENGINEER_PENDING';
    mocks.identityRefreshMock.mockReset().mockResolvedValue({ status: 'unchanged' });
    mocks.refreshMock.mockReset();
    mocks.retryMock.mockReset();
    mocks.state.current = READY_STATE;
  });

  afterEach(() => {
    cleanup();
  });

  it('先复核会话身份，仍受限时再重查申请', async () => {
    render(<RestrictedApplicationCard />);
    await clickRefresh();

    await waitFor(() => expect(mocks.refreshMock).toHaveBeenCalledTimes(1));
    expect(mocks.identityRefreshMock).toHaveBeenCalledTimes(1);
  });

  it('资格复核后已生效（NONE）时不重复发起受限申请查询', async () => {
    mocks.currentRestriction.current = 'NONE';
    render(<RestrictedApplicationCard />);
    await clickRefresh();

    await waitFor(() => expect(mocks.identityRefreshMock).toHaveBeenCalledTimes(1));
    expect(mocks.refreshMock).not.toHaveBeenCalled();
  });

  it('身份复核失败不污染申请状态，仍按当前会话事实重查', async () => {
    mocks.identityRefreshMock.mockRejectedValueOnce(new Error('network'));
    render(<RestrictedApplicationCard />);
    await clickRefresh();

    await waitFor(() => expect(mocks.refreshMock).toHaveBeenCalledTimes(1));
  });

  it('复核结果为 stale（迟到 / 被覆盖）时不当作当前会话结论，仍按当前会话重查', async () => {
    mocks.identityRefreshMock.mockResolvedValueOnce({ status: 'stale' });
    render(<RestrictedApplicationCard />);
    await clickRefresh();

    await waitFor(() => expect(mocks.refreshMock).toHaveBeenCalledTimes(1));
  });

  it('会话已失效（无当前会话）时不重查申请', async () => {
    mocks.currentRestriction.current = null as unknown as AuthSessionRestriction;
    render(<RestrictedApplicationCard />);
    await clickRefresh();

    await waitFor(() => expect(mocks.identityRefreshMock).toHaveBeenCalledTimes(1));
    expect(mocks.refreshMock).not.toHaveBeenCalled();
  });

  it('复核期间刷新按钮进入 loading，避免重复提交', async () => {
    const pending = deferred<{ status: 'unchanged' }>();
    mocks.identityRefreshMock.mockReturnValueOnce(pending.promise);
    render(<RestrictedApplicationCard />);

    await clickRefresh();

    await waitFor(() => {
      // loading 时 antd 会插入 loading 图标并进入 ant-btn-loading
      expect(screen.getByRole('button', { name: /刷新状态/ })).toHaveClass('ant-btn-loading');
    });

    pending.resolve({ status: 'unchanged' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /刷新状态/ })).not.toHaveClass('ant-btn-loading');
    });
  });

  it('无申请记录的空态同样提供刷新入口', async () => {
    mocks.state.current = { application: null, status: 'ready' };
    render(<RestrictedApplicationCard />);

    expect(screen.getByText('当前账号没有工程师注册申请记录。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新状态' })).toBeInTheDocument();
  });

  it('加载失败态保留独立重试，同时提供刷新入口', () => {
    mocks.state.current = { message: '申请信息加载失败', status: 'failed' };
    render(<RestrictedApplicationCard />);

    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新状态' })).toBeInTheDocument();
  });
});
