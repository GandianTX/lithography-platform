// src/features/auth-session/ui/login-form.spec.tsx

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import type { AuthSessionView } from '../application/auth-session.types';
import { loginWithPassword } from '../auth-session-entry';

import { LoginForm } from './login-form';

vi.mock('../auth-session-entry', () => ({
  loginWithPassword: vi.fn(),
}));

const mockedLoginWithPassword = vi.mocked(loginWithPassword);

const authenticatedView: AuthSessionView = {
  accountId: 900101,
  adminLevel: null,
  customerOrganizationId: null,
  engineerOrganizationId: null,
  adminOrganizationId: null,
  registrationOrganizationId: null,
  restriction: 'NONE',
  role: 'ENGINEER',
  userInfo: null,
};

function fillCredentials(loginName: string, loginPassword: string) {
  fireEvent.change(screen.getByLabelText('账号或邮箱'), {
    target: { value: loginName },
  });
  fireEvent.change(screen.getByLabelText('密码'), {
    target: { value: loginPassword },
  });
}

// antd 对双字按钮自动插入空格，可访问名是「登 录」。
function getSubmitButton() {
  return screen.getByRole('button', { name: /登\s*录/ });
}

describe('LoginForm', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('submits the existing login usecase once and hands the safe session view to onAuthenticated', async () => {
    mockedLoginWithPassword.mockResolvedValue(authenticatedView);
    const onAuthenticated = vi.fn();
    render(<LoginForm onAuthenticated={onAuthenticated} />);

    fillCredentials('mock_engineer_chen', 'test-only-password');
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(mockedLoginWithPassword).toHaveBeenCalledTimes(1);
    });
    expect(mockedLoginWithPassword).toHaveBeenCalledWith({
      loginName: 'mock_engineer_chen',
      loginPassword: 'test-only-password',
    });
    await waitFor(() => {
      expect(onAuthenticated).toHaveBeenCalledWith(authenticatedView);
    });
    expect(screen.getByText('登录成功，会话已建立。')).toBeInTheDocument();
  });

  it('keeps the login name, clears the password and allows resubmit after a credential rejection', async () => {
    mockedLoginWithPassword.mockRejectedValue(
      new GraphQLIngressError({ message: 'rejected', type: 'auth' }),
    );
    render(<LoginForm />);

    fillCredentials('mock_engineer_chen', 'wrong-password');
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(screen.getByText('账号或密码错误，请检查后重试。')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('账号或邮箱')).toHaveValue('mock_engineer_chen');
    expect(screen.getByLabelText('密码')).toHaveValue('');
    expect(getSubmitButton()).not.toBeDisabled();

    mockedLoginWithPassword.mockResolvedValue(authenticatedView);
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'fixed-password' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(mockedLoginWithPassword).toHaveBeenCalledTimes(2);
    });
  });

  it('keeps the login name, clears the password and shows recoverable transport feedback', async () => {
    mockedLoginWithPassword.mockRejectedValue(
      new GraphQLIngressError({ message: 'fetch failed', type: 'network' }),
    );
    render(<LoginForm />);

    fillCredentials('mock_engineer_chen', 'test-only-password');
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(screen.getByText('网络连接异常，请稍后重试。')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('账号或邮箱')).toHaveValue('mock_engineer_chen');
    expect(screen.getByLabelText('密码')).toHaveValue('');
    expect(getSubmitButton()).not.toBeDisabled();
    expect(screen.queryByText('fetch failed')).not.toBeInTheDocument();
  });

  it('blocks duplicate submissions while a request is in flight', async () => {
    let resolveLogin: (session: AuthSessionView) => void = () => {};
    mockedLoginWithPassword.mockImplementation(
      () =>
        new Promise<AuthSessionView>((resolve) => {
          resolveLogin = resolve;
        }),
    );
    render(<LoginForm />);

    fillCredentials('mock_engineer_chen', 'test-only-password');
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(getSubmitButton()).toHaveClass('ant-btn-loading');
    });
    fireEvent.click(getSubmitButton());
    expect(mockedLoginWithPassword).toHaveBeenCalledTimes(1);

    resolveLogin(authenticatedView);

    await waitFor(() => {
      expect(getSubmitButton()).not.toHaveClass('ant-btn-loading');
    });
    // 成功后密码已被清空，重填后才能再次提交。
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'next-password' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(mockedLoginWithPassword).toHaveBeenCalledTimes(2);
    });
  });

  it('lets the existing form rules block empty input without calling the login usecase', async () => {
    render(<LoginForm />);

    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(screen.getByText('请输入账号或邮箱。')).toBeInTheDocument();
      expect(screen.getByText('请输入密码。')).toBeInTheDocument();
    });
    expect(mockedLoginWithPassword).not.toHaveBeenCalled();
  });

  /**
   * 键盘提交（Enter 触发的表单 submit）与点击按钮共用同一条 `onFinish` 路径；
   * jsdom 不实现输入框的隐式提交，这里直接派发表单 submit 事件等价驱动。
   * 第二次提交要先完成自己的异步校验才会进到 `onFinish`，因此必须在第一次请求仍在途时
   * 把校验排空，才能观察到 `submittingRef` 守卫——这正是点击路径观察不到的一层：
   * antd 的 loading 按钮会直接吞掉第二次 click，而键盘提交不会经过按钮。
   */
  it('submits from the keyboard and still coalesces an in-flight duplicate', async () => {
    let resolveLogin: (session: AuthSessionView) => void = () => {};
    mockedLoginWithPassword.mockImplementation(
      () =>
        new Promise<AuthSessionView>((resolve) => {
          resolveLogin = resolve;
        }),
    );
    render(<LoginForm />);

    fillCredentials('mock_engineer_chen', 'test-only-password');

    const form = screen.getByLabelText('密码').closest('form') as HTMLFormElement;
    expect(form).not.toBeNull();

    fireEvent.submit(form);
    await waitFor(() => {
      expect(mockedLoginWithPassword).toHaveBeenCalledTimes(1);
    });

    // 在途期间再次回车：让它的校验先跑完，守卫必须仍然只放行一次凭据校验。
    fireEvent.submit(form);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockedLoginWithPassword).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveLogin(authenticatedView);
    });

    await waitFor(() => {
      expect(screen.getByText('登录成功，会话已建立。')).toBeInTheDocument();
    });
  });
});
