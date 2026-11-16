// src/features/account-settings/ui/change-password-form.spec.tsx
// @vitest-environment jsdom

/**
 * 安全设置（修改密码）表单 UI 单测。
 *
 * 走真实组件与真实 antd 校验规则，onSubmit 由测试注入：验证必填与「两次输入一致」
 * 的客户端拦截、密码强度不在前端裁决（策略以后端为准）、当前密码错误 / 弱密码等
 * 业务拒绝文案原样展示，以及成功链路的**身份裁决先于提示**——先交由调用方
 * （装配层）裁决发起会话身份，仅裁决为「仍是当前会话」时才展示成功提示；
 * 身份不匹配（迟到响应）完全静默。真实提交失败（业务拒绝 / 请求失败）后三个密码
 * 输入必须清空且错误提示保持可见；in-flight 未真实提交时不清空。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { message } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangeMyPasswordFailureReason,
  ChangeMyPasswordInput,
  ChangeMyPasswordResult,
} from '../application/account-settings.types';
import type { AccountSettingsCommandExecution } from '../application/use-account-settings';

import { ChangePasswordForm } from './change-password-form';

type SubmitExecution = AccountSettingsCommandExecution<ChangeMyPasswordResult>;

const NOTICE = '密码已更新，请使用新密码重新登录';
const MISMATCH_MESSAGE = '两次输入的新密码不一致';
const CURRENT_PASSWORD = 'Old#Pass2026';
const NEW_PASSWORD = 'Str0ng#Pass2026';

function getSubmitButton() {
  // loading 态下 antd 会插入 aria-label="loading" 的图标，可访问名带前缀，故用正则匹配
  return screen.getByRole('button', { name: /修\s*改\s*密\s*码/ });
}

function getResetButton() {
  return screen.getByRole('button', { name: /重\s*置/ });
}

function fillPasswords(current: string, next: string, confirm: string) {
  fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: current } });
  fireEvent.change(screen.getByLabelText('新密码'), { target: { value: next } });
  fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: confirm } });
}

function successExecution(
  notice = NOTICE,
  initiatedIdentity: { accountId: number; epoch: number } | null = null,
): SubmitExecution {
  return { kind: 'ok', result: { initiatedIdentity, notice, ok: true } };
}

function failureExecution(
  text: string,
  reason: ChangeMyPasswordFailureReason = 'invalid-input',
): SubmitExecution {
  return { kind: 'ok', result: { message: text, ok: false, reason } };
}

function renderForm(
  onSubmit: (input: ChangeMyPasswordInput) => Promise<SubmitExecution>,
  options?: {
    onSucceeded?: (
      initiatedIdentity: { accountId: number; epoch: number } | null,
    ) => boolean | Promise<boolean>;
    submitting?: boolean;
  },
) {
  return render(
    <ChangePasswordForm
      onSucceeded={options?.onSucceeded}
      onSubmit={onSubmit}
      submitting={options?.submitting ?? false}
    />,
  );
}

beforeEach(() => {
  vi.spyOn(message, 'success')
    .mockImplementation(() => undefined as never)
    .mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ChangePasswordForm 客户端拦截', () => {
  it('三个字段全部为空时拦截提交并给出各自的必填提示', async () => {
    const onSubmit = vi.fn();
    renderForm(onSubmit);

    fireEvent.click(getSubmitButton());

    expect(await screen.findByText('请输入当前密码')).toBeInTheDocument();
    expect(screen.getByText('请输入新密码')).toBeInTheDocument();
    expect(screen.getByText('请再次输入新密码')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    ['当前密码缺失', '', NEW_PASSWORD, NEW_PASSWORD, '请输入当前密码'],
    ['新密码缺失', CURRENT_PASSWORD, '', '', '请输入新密码'],
    ['确认新密码缺失', CURRENT_PASSWORD, NEW_PASSWORD, '', '请再次输入新密码'],
  ])('%s 时拦截提交并提示', async (_label, current, next, confirm, expected) => {
    const onSubmit = vi.fn();
    renderForm(onSubmit);

    fillPasswords(current, next, confirm);
    fireEvent.click(getSubmitButton());

    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('两次新密码不一致时在客户端拦截，不发起任何请求', async () => {
    const onSubmit = vi.fn();
    renderForm(onSubmit);

    fillPasswords(CURRENT_PASSWORD, NEW_PASSWORD, 'Another#Pass2026');
    fireEvent.click(getSubmitButton());

    expect(await screen.findByText(MISMATCH_MESSAGE)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('密码强度不在前端裁决：弱密码仍提交给后端，界面只给策略说明', async () => {
    const onSubmit = vi.fn().mockResolvedValue(successExecution());
    renderForm(onSubmit);

    expect(screen.getByText(/密码强度与格式以后端校验为准。/)).toBeInTheDocument();

    fillPasswords(CURRENT_PASSWORD, '123', '123');
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(MISMATCH_MESSAGE)).not.toBeInTheDocument();
  });

  it('提交入参只含当前密码与新密码，不含确认字段', async () => {
    const onSubmit = vi.fn().mockResolvedValue(successExecution());
    renderForm(onSubmit);

    fillPasswords(CURRENT_PASSWORD, NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      currentPassword: CURRENT_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    const input = onSubmit.mock.calls[0]?.[0] as ChangeMyPasswordInput;

    expect(Object.keys(input).sort()).toEqual(['currentPassword', 'newPassword']);
  });
});

describe('ChangePasswordForm 成功链路', () => {
  it('身份裁决先于提示：先交由调用方裁决会话身份，仅匹配时展示后端固定提示', async () => {
    const order: string[] = [];
    vi.spyOn(message, 'success').mockImplementation(((text: string) => {
      order.push(`notice:${text}`);

      return undefined;
    }) as never);
    const onSucceeded = vi.fn().mockImplementation(async () => {
      order.push('identity-check');

      return true;
    });
    const onSubmit = vi.fn().mockResolvedValue(successExecution());
    renderForm(onSubmit, { onSucceeded });

    fillPasswords(CURRENT_PASSWORD, NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(onSucceeded).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['identity-check', `notice:${NOTICE}`]);
    expect(onSucceeded).toHaveBeenCalledWith(null);
  });

  it('身份裁决为不匹配（迟到响应）时完全静默：不展示成功提示，也不再有任何提示行为', async () => {
    const onSucceeded = vi.fn().mockResolvedValue(false);
    const onSubmit = vi
      .fn()
      .mockResolvedValue(successExecution(NOTICE, { accountId: 900201, epoch: 1 }));
    renderForm(onSubmit, { onSucceeded });

    fillPasswords(CURRENT_PASSWORD, NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(onSucceeded).toHaveBeenCalledTimes(1));
    expect(onSucceeded).toHaveBeenCalledWith({ accountId: 900201, epoch: 1 });
    expect(message.success).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('成功结果携带的发起时会话身份原样传给调用方，不丢失、不改写', async () => {
    const onSucceeded = vi.fn();
    const onSubmit = vi
      .fn()
      .mockResolvedValue(successExecution(NOTICE, { accountId: 900201, epoch: 1 }));
    renderForm(onSubmit, { onSucceeded });

    fillPasswords(CURRENT_PASSWORD, NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(onSucceeded).toHaveBeenCalledTimes(1));
    expect(onSucceeded).toHaveBeenCalledWith({ accountId: 900201, epoch: 1 });
  });

  it('调用方未接线会话收口时，成功链路仍只展示提示且不抛错', async () => {
    const onSubmit = vi.fn().mockResolvedValue(successExecution());
    renderForm(onSubmit);

    fillPasswords(CURRENT_PASSWORD, NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(message.success).toHaveBeenCalledWith(NOTICE));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('成功提示只用后端返回的 notice，不回显任何密码内容', async () => {
    const onSubmit = vi.fn().mockResolvedValue(successExecution());
    renderForm(onSubmit);

    fillPasswords(CURRENT_PASSWORD, NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(message.success).toHaveBeenCalledTimes(1));
    expect(message.success).toHaveBeenCalledWith(NOTICE);
    const noticeText = vi.mocked(message.success).mock.calls[0]?.[0] as string;

    expect(noticeText).not.toContain(NEW_PASSWORD);
    expect(noticeText).not.toContain(CURRENT_PASSWORD);
  });
});

describe('ChangePasswordForm 业务拒绝与失败边界', () => {
  it('当前密码错误时展示后端输入类文案，不提示成功也不触发会话收口', async () => {
    const onSucceeded = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue(failureExecution('当前密码不正确'));
    renderForm(onSubmit, { onSucceeded });

    fillPasswords('Wrong#Pass2026', NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getSubmitButton());

    expect(await screen.findByText('当前密码不正确')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('当前密码不正确');
    expect(message.success).not.toHaveBeenCalled();
    expect(onSucceeded).not.toHaveBeenCalled();
    // 真实提交失败后清空三个密码输入，错误提示保持可见
    expect(screen.getByLabelText('当前密码')).toHaveValue('');
    expect(screen.getByLabelText('新密码')).toHaveValue('');
    expect(screen.getByLabelText('确认新密码')).toHaveValue('');
  });

  it('新密码不符合后端策略时展示后端返回的策略文案', async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValue(failureExecution('新密码不符合安全要求: 长度至少 8 位, 必须包含数字'));
    renderForm(onSubmit);

    fillPasswords(CURRENT_PASSWORD, 'weak', 'weak');
    fireEvent.click(getSubmitButton());

    expect(
      await screen.findByText('新密码不符合安全要求: 长度至少 8 位, 必须包含数字'),
    ).toBeInTheDocument();
    expect(message.success).not.toHaveBeenCalled();
  });

  it.each<[ChangeMyPasswordFailureReason, string]>([
    ['forbidden', '当前身份无权执行该操作。'],
    ['update-failed', '操作失败，请稍后重试。'],
  ])('%s 类业务拒绝原样展示后端文案', async (reason, text) => {
    const onSubmit = vi.fn().mockResolvedValue(failureExecution(text, reason));
    renderForm(onSubmit);

    fillPasswords(CURRENT_PASSWORD, NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getSubmitButton());

    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(message.success).not.toHaveBeenCalled();
  });

  it('transport 类失败展示收敛兜底文案，不触发会话收口', async () => {
    const onSucceeded = vi.fn();
    const onSubmit = vi
      .fn()
      .mockResolvedValue({ kind: 'unhandled-error', message: '网络连接异常，请稍后重试。' });
    renderForm(onSubmit, { onSucceeded });

    fillPasswords(CURRENT_PASSWORD, NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getSubmitButton());

    expect(await screen.findByText('网络连接异常，请稍后重试。')).toBeInTheDocument();
    expect(onSucceeded).not.toHaveBeenCalled();
    expect(message.success).not.toHaveBeenCalled();
    // 请求失败同样清空三个密码输入，错误提示保持可见
    expect(screen.getByRole('alert')).toHaveTextContent('网络连接异常，请稍后重试。');
    expect(screen.getByLabelText('当前密码')).toHaveValue('');
    expect(screen.getByLabelText('新密码')).toHaveValue('');
    expect(screen.getByLabelText('确认新密码')).toHaveValue('');
  });

  it('同类命令进行中被拒（in-flight）时静默忽略', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ kind: 'in-flight' });
    renderForm(onSubmit);

    fillPasswords(CURRENT_PASSWORD, NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(message.success).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // 未真实提交（未发出请求）时不清空输入
    expect(screen.getByLabelText('当前密码')).toHaveValue(CURRENT_PASSWORD);
    expect(screen.getByLabelText('新密码')).toHaveValue(NEW_PASSWORD);
    expect(screen.getByLabelText('确认新密码')).toHaveValue(NEW_PASSWORD);
  });

  it('失败清空后可重新输入并成功提交', async () => {
    const onSucceeded = vi.fn().mockResolvedValue(true);
    const onSubmit = vi
      .fn()
      .mockResolvedValueOnce(failureExecution('当前密码不正确'))
      .mockResolvedValueOnce(successExecution());
    renderForm(onSubmit, { onSucceeded });

    fillPasswords('Wrong#Pass2026', NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getSubmitButton());
    expect(await screen.findByText('当前密码不正确')).toBeInTheDocument();

    fillPasswords(CURRENT_PASSWORD, NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(message.success).toHaveBeenCalledWith(NOTICE));
    expect(onSubmit).toHaveBeenLastCalledWith({
      currentPassword: CURRENT_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('失败后点击重置会移除错误提示，三个字段保持为空', async () => {
    const onSubmit = vi.fn().mockResolvedValue(failureExecution('当前密码不正确'));
    renderForm(onSubmit);

    fillPasswords('Wrong#Pass2026', NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getSubmitButton());
    expect(await screen.findByText('当前密码不正确')).toBeInTheDocument();

    fireEvent.click(getResetButton());

    await waitFor(() => expect(screen.queryByText('当前密码不正确')).not.toBeInTheDocument());
    expect(screen.getByLabelText('当前密码')).toHaveValue('');
    expect(screen.getByLabelText('新密码')).toHaveValue('');
    expect(screen.getByLabelText('确认新密码')).toHaveValue('');
  });

  it('提交进行中按钮 loading、重置禁用，重复点击不再触发 onSubmit', () => {
    const onSubmit = vi.fn();
    renderForm(onSubmit, { submitting: true });

    fireEvent.click(getSubmitButton());
    fireEvent.click(getSubmitButton());

    expect(getSubmitButton()).toHaveClass('ant-btn-loading');
    expect(getResetButton()).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
