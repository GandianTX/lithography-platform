// src/features/account-settings/ui/change-password-form.spec.tsx
// @vitest-environment jsdom

/**
 * 安全设置（修改密码）表单 UI 单测。
 *
 * 走真实组件与真实 antd 校验规则，onSubmit 由测试注入：验证必填与「两次输入一致」
 * 的客户端拦截、密码强度不在前端裁决（策略以后端为准）、当前密码错误 / 弱密码等
 * 业务拒绝按界面语言展示**本地化**操作反馈（不直接透传后端中文原文），以及成功链路的
 * **身份裁决先于提示**——先交由调用方（装配层）裁决发起会话身份，仅裁决为「仍是当前会话」
 * 时才展示本地成功提示；身份不匹配（迟到响应）完全静默。真实提交失败（业务拒绝 / 请求失败）
 * 后三个密码输入必须清空且错误提示保持可见；in-flight 未真实提交时不清空。
 */

import { useEffect, useMemo, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { message } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AppLanguage, createTranslator, I18nContext, setRuntimeLanguage } from '@/shared/i18n';

import type {
  ChangeMyPasswordFailureReason,
  ChangeMyPasswordInput,
  ChangeMyPasswordResult,
} from '../application/account-settings.types';
import type { AccountSettingsCommandExecution } from '../application/use-account-settings';

import { ChangePasswordForm } from './change-password-form';

type SubmitExecution = AccountSettingsCommandExecution<ChangeMyPasswordResult>;

const NOTICE = '密码已更新，请使用新密码重新登录';
const ZH_SUCCESS = '密码已更新，请使用新密码重新登录。';
const ZH_REJECTED = '密码未更新，请核对当前密码及新密码要求后重试。';
const MISMATCH_MESSAGE = '两次输入的新密码不一致';
const CURRENT_PASSWORD = 'Old#Pass2026';
const NEW_PASSWORD = 'Str0ng#Pass2026';

const EN_SUCCESS = 'Password updated. Sign in again with your new password.';
const EN_REJECTED =
  'Password not updated. Check your current password and the new password requirements, then try again.';

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

/**
 * 双语夹具：真实 `I18nContext` + 语言切换按钮，并把当前语言同步到 runtime translator
 * （与 `I18nProvider` 的 effect 行为一致），用于验证展示层文案随界面语言变化。
 */
function BilingualHarness({
  initialLanguage,
  onSubmit,
  onSucceeded,
}: {
  initialLanguage: AppLanguage;
  onSubmit: (input: ChangeMyPasswordInput) => Promise<SubmitExecution>;
  onSucceeded?: (
    initiatedIdentity: { accountId: number; epoch: number } | null,
  ) => boolean | Promise<boolean>;
}) {
  const [language, setLanguage] = useState<AppLanguage>(initialLanguage);

  useEffect(() => {
    setRuntimeLanguage(language);
  }, [language]);

  const t = useMemo(() => createTranslator(language), [language]);
  const value = useMemo(() => ({ language, setLanguage, t }), [language, t]);

  return (
    <I18nContext.Provider value={value}>
      <button onClick={() => setLanguage(language === 'en' ? 'zh-CN' : 'en')} type="button">
        切换界面语言
      </button>
      <ChangePasswordForm onSubmit={onSubmit} onSucceeded={onSucceeded} submitting={false} />
    </I18nContext.Provider>
  );
}

function renderFormInLanguage(
  language: AppLanguage,
  onSubmit: (input: ChangeMyPasswordInput) => Promise<SubmitExecution>,
  options?: {
    onSucceeded?: (
      initiatedIdentity: { accountId: number; epoch: number } | null,
    ) => boolean | Promise<boolean>;
  },
) {
  return render(
    <BilingualHarness
      initialLanguage={language}
      onSubmit={onSubmit}
      onSucceeded={options?.onSucceeded}
    />,
  );
}

function fillEnglishPasswords(current: string, next: string, confirm: string) {
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: current } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: next } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: confirm } });
}

function getEnglishSubmitButton() {
  return screen.getByRole('button', { name: /Change password/ });
}

function switchLanguage() {
  fireEvent.click(screen.getByRole('button', { name: '切换界面语言' }));
}

beforeEach(() => {
  setRuntimeLanguage('zh-CN');
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
  it('身份裁决先于提示：先交由调用方裁决会话身份，仅匹配时展示本地成功提示', async () => {
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
    expect(order).toEqual(['identity-check', `notice:${ZH_SUCCESS}`]);
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

    await waitFor(() => expect(message.success).toHaveBeenCalledWith(ZH_SUCCESS));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('成功提示只使用本地成功词条，不回显后端 notice 或任何密码内容', async () => {
    const onSubmit = vi.fn().mockResolvedValue(successExecution());
    renderForm(onSubmit);

    fillPasswords(CURRENT_PASSWORD, NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(message.success).toHaveBeenCalledTimes(1));
    expect(message.success).toHaveBeenCalledWith(ZH_SUCCESS);
    const noticeText = vi.mocked(message.success).mock.calls[0]?.[0] as string;

    expect(noticeText).toContain('重新登录');
    expect(noticeText).not.toContain(NEW_PASSWORD);
    expect(noticeText).not.toContain(CURRENT_PASSWORD);
  });
});

describe('ChangePasswordForm 业务拒绝与失败边界', () => {
  it('当前密码错误时展示本地可操作提示，不提示成功也不触发会话收口', async () => {
    const onSucceeded = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue(failureExecution('当前密码不正确'));
    renderForm(onSubmit, { onSucceeded });

    fillPasswords('Wrong#Pass2026', NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getSubmitButton());

    expect(await screen.findByText(ZH_REJECTED)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(ZH_REJECTED);
    expect(screen.getByRole('alert')).not.toHaveTextContent('当前密码不正确');
    expect(message.success).not.toHaveBeenCalled();
    expect(onSucceeded).not.toHaveBeenCalled();
    // 真实提交失败后清空三个密码输入，错误提示保持可见
    expect(screen.getByLabelText('当前密码')).toHaveValue('');
    expect(screen.getByLabelText('新密码')).toHaveValue('');
    expect(screen.getByLabelText('确认新密码')).toHaveValue('');
  });

  it('新密码不符合后端策略时使用同一本地提示，不泄露后端策略细节', async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValue(failureExecution('新密码不符合安全要求: 长度至少 8 位, 必须包含数字'));
    renderForm(onSubmit);

    fillPasswords(CURRENT_PASSWORD, 'weak', 'weak');
    fireEvent.click(getSubmitButton());

    expect(await screen.findByText(ZH_REJECTED)).toBeInTheDocument();
    expect(screen.getByRole('alert')).not.toHaveTextContent('新密码不符合安全要求');
    expect(message.success).not.toHaveBeenCalled();
  });

  it.each<[ChangeMyPasswordFailureReason, string, string]>([
    ['forbidden', '后端拒绝原文', '当前身份无权执行该操作。'],
    ['update-failed', '后端失败原文', '操作失败，请稍后重试。'],
  ])('%s 类业务拒绝使用本地固定反馈，不透传后端原文', async (reason, backendText, expected) => {
    const onSubmit = vi.fn().mockResolvedValue(failureExecution(backendText, reason));
    renderForm(onSubmit);

    fillPasswords(CURRENT_PASSWORD, NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getSubmitButton());

    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.getByRole('alert')).not.toHaveTextContent(backendText);
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
    expect(await screen.findByText(ZH_REJECTED)).toBeInTheDocument();

    fillPasswords(CURRENT_PASSWORD, NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(message.success).toHaveBeenCalledWith(ZH_SUCCESS));
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
    expect(await screen.findByText(ZH_REJECTED)).toBeInTheDocument();

    fireEvent.click(getResetButton());

    await waitFor(() => expect(screen.queryByText(ZH_REJECTED)).not.toBeInTheDocument());
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

describe('ChangePasswordForm 双语操作反馈（B 审查 R1）', () => {
  it('英文界面下成功提示使用本地化文案，不直接展示后端中文 notice', async () => {
    const onSubmit = vi.fn().mockResolvedValue(successExecution());
    renderFormInLanguage('en', onSubmit);

    fillEnglishPasswords(CURRENT_PASSWORD, NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getEnglishSubmitButton());

    await waitFor(() => expect(message.success).toHaveBeenCalledTimes(1));
    expect(message.success).toHaveBeenCalledWith(EN_SUCCESS);
    expect(message.success).not.toHaveBeenCalledWith(NOTICE);
  });

  it('英文界面下当前密码错误显示本地化可操作提示，清空三框且不触发成功收口', async () => {
    const onSucceeded = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue(failureExecution('当前密码不正确'));
    renderFormInLanguage('en', onSubmit, { onSucceeded });

    fillEnglishPasswords('Wrong#Pass2026', NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getEnglishSubmitButton());

    expect(await screen.findByText(EN_REJECTED)).toBeInTheDocument();
    expect(screen.getByRole('alert')).not.toHaveTextContent('当前密码不正确');
    expect(screen.getByLabelText('Current password')).toHaveValue('');
    expect(screen.getByLabelText('New password')).toHaveValue('');
    expect(screen.getByLabelText('Confirm new password')).toHaveValue('');
    expect(message.success).not.toHaveBeenCalled();
    expect(onSucceeded).not.toHaveBeenCalled();
  });

  it('英文界面下新密码被拒同样使用本地化提示，不泄露后端策略细节', async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValue(failureExecution('新密码不符合安全要求: 长度至少 8 位, 必须包含数字'));
    renderFormInLanguage('en', onSubmit);

    fillEnglishPasswords(CURRENT_PASSWORD, 'weak', 'weak');
    fireEvent.click(getEnglishSubmitButton());

    expect(await screen.findByText(EN_REJECTED)).toBeInTheDocument();
    expect(screen.getByRole('alert')).not.toHaveTextContent('新密码不符合安全要求');
    expect(onSubmit).toHaveBeenCalledWith({
      currentPassword: CURRENT_PASSWORD,
      newPassword: 'weak',
    });
    expect(message.success).not.toHaveBeenCalled();
  });

  it('请求进行中切换语言：不重复提交，成功提示采用完成时的当前语言', async () => {
    let resolveSubmit: (value: SubmitExecution) => void = () => undefined;
    const onSubmit = vi.fn().mockReturnValue(
      new Promise<SubmitExecution>((resolve) => {
        resolveSubmit = resolve;
      }),
    );
    renderFormInLanguage('zh-CN', onSubmit);

    fillPasswords(CURRENT_PASSWORD, NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getSubmitButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    switchLanguage();
    // 语言切换不触发第二次提交；表单仍处于在途状态
    expect(onSubmit).toHaveBeenCalledTimes(1);

    resolveSubmit(successExecution());

    await waitFor(() => expect(message.success).toHaveBeenCalledTimes(1));
    expect(message.success).toHaveBeenCalledWith(EN_SUCCESS);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('失败反馈出现后切换语言：已显示的固定错误随当前语言更新，密码字段保持清空', async () => {
    const onSubmit = vi.fn().mockResolvedValue(failureExecution('当前密码不正确'));
    renderFormInLanguage('zh-CN', onSubmit);

    fillPasswords('Wrong#Pass2026', NEW_PASSWORD, NEW_PASSWORD);
    fireEvent.click(getSubmitButton());

    expect(
      await screen.findByText('密码未更新，请核对当前密码及新密码要求后重试。'),
    ).toBeInTheDocument();

    switchLanguage();

    expect(await screen.findByText(EN_REJECTED)).toBeInTheDocument();
    expect(
      screen.queryByText('密码未更新，请核对当前密码及新密码要求后重试。'),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Current password')).toHaveValue('');
    expect(screen.getByLabelText('New password')).toHaveValue('');
    expect(screen.getByLabelText('Confirm new password')).toHaveValue('');
  });
});
