// src/features/account-settings/ui/account-profile-form.spec.tsx
// @vitest-environment jsdom

/**
 * 基础资料表单 UI 单测。
 *
 * 走真实组件与真实 antd 校验规则，onSubmit 由测试注入：验证昵称必填守卫、
 * 四字段三态草稿构造（空 → null、非空 trim、姓名三态）、公司只读展示、
 * 受限模式下不渲染也不提交姓名/公司、成功 / 未变化两种提示、
 * 「联系邮箱不是登录凭据」的界面口径，以及 editVersionRef 陈旧响应守卫。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { message } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AccountSettingsProfileDraft,
  AccountSettingsProfileUpdateResult,
  AccountSettingsView,
} from '../application/account-settings.types';
import type { AccountSettingsCommandExecution } from '../application/use-account-settings';

import { AccountProfileForm } from './account-profile-form';

const SETTINGS: AccountSettingsView = {
  adminLevel: 2,
  companyName: '示例公司',
  contactEmail: 'contact@example.com',
  loginEmail: 'self@example.com',
  loginName: 'self_user',
  nickname: '陈工',
  phone: '13800000000',
  realName: '张三',
  role: 'ENGINEER',
  status: 'ACTIVE',
  trustedCompanyName: '可信公司',
  updatedAt: '2026-01-01T08:00:00.000Z',
};

type SubmitExecution = AccountSettingsCommandExecution<AccountSettingsProfileUpdateResult>;

function getSubmitButton() {
  return screen.getByRole('button', { name: /保\s*存/ });
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function renderForm(
  onSubmit: (draft: AccountSettingsProfileDraft) => Promise<SubmitExecution>,
  mode?: 'full' | 'restricted',
) {
  return render(
    <AccountProfileForm mode={mode} onSubmit={onSubmit} settings={SETTINGS} submitting={false} />,
  );
}

function successResult(
  overrides?: Partial<AccountSettingsView>,
  isUpdated = true,
): SubmitExecution {
  return { kind: 'ok', result: { isUpdated, ok: true, settings: { ...SETTINGS, ...overrides } } };
}

/** 可控提交：测试自行决定响应何时回来，以复现「请求期间继续输入」的竞态 */
function deferredSubmit() {
  let resolveExecution: (execution: SubmitExecution) => void = () => {};
  const onSubmit = vi.fn().mockImplementation(
    () =>
      new Promise<SubmitExecution>((resolve) => {
        resolveExecution = resolve;
      }),
  );

  return { onSubmit, resolve: (execution: SubmitExecution) => resolveExecution(execution) };
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

describe('AccountProfileForm 客户端校验与草稿构造', () => {
  it.each([[''], ['   ']])('昵称为 %s 时拦截提交并提示请输入昵称', async (nickname) => {
    const onSubmit = vi.fn();
    renderForm(onSubmit);

    fill('昵称', nickname);
    fireEvent.click(getSubmitButton());

    expect(await screen.findByText('请输入昵称')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([['not-an-email'], ['  not-an-email  ']])(
    '联系邮箱为 %s 时拦截提交（trim 不会让非法值蒙混过关）',
    async (contactEmail) => {
      const onSubmit = vi.fn();
      renderForm(onSubmit);

      fill('联系邮箱（非登录凭据）', contactEmail);
      fireEvent.click(getSubmitButton());

      expect(await screen.findByText('联系邮箱格式不正确')).toBeInTheDocument();
      expect(onSubmit).not.toHaveBeenCalled();
    },
  );

  it('提交四个字段：空输入归 null（清空），非空 trim 后设置', async () => {
    const onSubmit = vi.fn().mockResolvedValue(successResult());
    renderForm(onSubmit);

    fill('姓名', '  李四  ');
    fill('昵称', '  新昵称  ');
    fill('电话', '   ');
    fill('联系邮箱（非登录凭据）', 'new-contact@example.com');
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      contactEmail: 'new-contact@example.com',
      nickname: '新昵称',
      phone: null,
      realName: '李四',
    });
  });

  it('姓名可清空：空输入按三态语义提交 null', async () => {
    const onSubmit = vi.fn().mockResolvedValue(successResult({ realName: null }));
    renderForm(onSubmit);

    fill('姓名', '   ');
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      contactEmail: 'contact@example.com',
      nickname: '陈工',
      phone: '13800000000',
      realName: null,
    });
  });

  it('联系邮箱两侧带空白：通过前端校验，显示值不被改写，提交值已 trim', async () => {
    const onSubmit = vi.fn().mockResolvedValue(successResult());
    renderForm(onSubmit);

    fill('联系邮箱（非登录凭据）', '  new-contact@example.com  ');

    // trim 只作用于校验值：刻意不用 Input 的 normalize，用户输入过程中的显示值不被改写
    expect(screen.getByLabelText('联系邮箱（非登录凭据）')).toHaveValue(
      '  new-contact@example.com  ',
    );

    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      contactEmail: 'new-contact@example.com',
      nickname: '陈工',
      phone: '13800000000',
      realName: '张三',
    });
    expect(screen.queryByText('联系邮箱格式不正确')).not.toBeInTheDocument();
  });

  it('联系邮箱为纯空白：通过校验并按既有清空语义提交 null', async () => {
    const onSubmit = vi.fn().mockResolvedValue(successResult({ contactEmail: null }));
    renderForm(onSubmit);

    fill('联系邮箱（非登录凭据）', '   ');
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      contactEmail: null,
      nickname: '陈工',
      phone: '13800000000',
      realName: '张三',
    });
    expect(screen.queryByText('联系邮箱格式不正确')).not.toBeInTheDocument();
  });

  it('未修改时按当前视图值原样提交（同值由后端裁决为未变化）', async () => {
    const onSubmit = vi.fn().mockResolvedValue(successResult(undefined, false));
    renderForm(onSubmit);

    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      contactEmail: 'contact@example.com',
      nickname: '陈工',
      phone: '13800000000',
      realName: '张三',
    });
  });

  it('公司只读展示后端归属结果，不提供编辑控件，草稿不含公司字段', async () => {
    const onSubmit = vi.fn().mockResolvedValue(successResult());
    renderForm(onSubmit);

    expect(screen.getByText('可信公司')).toBeInTheDocument();
    expect(
      screen.getByText(
        '公司由账号归属决定；未关联时请在下方「公司信息」中补充，变更请联系管理员。',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('公司')).toBeNull();
    expect(screen.queryByRole('textbox', { name: /公司/ })).toBeNull();

    fill('昵称', '新昵称');
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const draft = onSubmit.mock.calls[0]?.[0] as AccountSettingsProfileDraft;

    expect(draft).not.toHaveProperty('companyName');
  });

  it('联系邮箱不用于登录：界面明示口径，草稿中不含任何登录凭据字段', async () => {
    const onSubmit = vi.fn().mockResolvedValue(successResult());
    renderForm(onSubmit);

    expect(screen.getByText('联系邮箱不用于登录，仅作联系方式。')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('昵称允许重复')).toBeInTheDocument();

    fill('联系邮箱（非登录凭据）', 'new-contact@example.com');
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const draft = onSubmit.mock.calls[0]?.[0] as AccountSettingsProfileDraft;

    expect(Object.keys(draft).sort()).toEqual(['contactEmail', 'nickname', 'phone', 'realName']);
    expect(draft).not.toHaveProperty('loginName');
    expect(draft).not.toHaveProperty('loginEmail');
  });
});

describe('AccountProfileForm 受限会话模式', () => {
  it('不渲染姓名编辑控件，公司只读展示可信归属结果', () => {
    renderForm(vi.fn(), 'restricted');

    expect(screen.queryByLabelText('姓名')).toBeNull();
    expect(screen.getByText('可信公司')).toBeInTheDocument();
    expect(
      screen.getByText(
        '公司由账号归属决定；未关联时请在下方「公司信息」中补充，变更请联系管理员。',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('公司')).toBeNull();
  });

  it('提交草稿不含 realName 与 companyName 键，只提交昵称、电话与联系邮箱', async () => {
    const onSubmit = vi.fn().mockResolvedValue(successResult());
    renderForm(onSubmit, 'restricted');

    fill('昵称', '新昵称');
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const draft = onSubmit.mock.calls[0]?.[0] as AccountSettingsProfileDraft;

    expect(draft).toEqual({
      contactEmail: 'contact@example.com',
      nickname: '新昵称',
      phone: '13800000000',
    });
    expect(draft).not.toHaveProperty('realName');
    expect(draft).not.toHaveProperty('companyName');
    expect(draft).not.toHaveProperty('loginName');
    expect(draft).not.toHaveProperty('loginEmail');
  });

  it('清空电话与联系邮箱只提交 null，不夹带姓名字段的空值', async () => {
    const onSubmit = vi.fn().mockResolvedValue(successResult());
    renderForm(onSubmit, 'restricted');

    fill('电话', '   ');
    fill('联系邮箱（非登录凭据）', '');
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const draft = onSubmit.mock.calls[0]?.[0] as AccountSettingsProfileDraft;

    expect(draft).toEqual({
      contactEmail: null,
      nickname: '陈工',
      phone: null,
    });
    expect(draft).not.toHaveProperty('realName');
    expect(draft).not.toHaveProperty('companyName');
  });
});

describe('AccountProfileForm 提交结果处理', () => {
  it('保存成功提示「基础资料已保存。」', async () => {
    const onSubmit = vi.fn().mockResolvedValue(successResult({ nickname: '新昵称' }));
    renderForm(onSubmit);

    fill('昵称', '新昵称');
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(message.success).toHaveBeenCalledWith('基础资料已保存。'));
  });

  it('后端判定同值（isUpdated=false）时提示「基础资料未发生变化。」', async () => {
    const onSubmit = vi.fn().mockResolvedValue(successResult(undefined, false));
    renderForm(onSubmit);

    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(message.success).toHaveBeenCalledWith('基础资料未发生变化。'));
    expect(message.success).not.toHaveBeenCalledWith('基础资料已保存。');
  });

  it('业务失败展示后端文案并保留用户填写的内容', async () => {
    const onSubmit = vi.fn().mockResolvedValue({
      kind: 'ok',
      result: { message: '输入不符合要求，请检查后重新提交。', ok: false, reason: 'invalid-input' },
    });
    renderForm(onSubmit);

    fill('姓名', '被拒绝的姓名');
    fill('昵称', '被拒绝的昵称');
    fill('电话', '123');
    fireEvent.click(getSubmitButton());

    expect(await screen.findByText('输入不符合要求，请检查后重新提交。')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('输入不符合要求，请检查后重新提交。');
    expect(screen.getByLabelText('姓名')).toHaveValue('被拒绝的姓名');
    expect(screen.getByLabelText('昵称')).toHaveValue('被拒绝的昵称');
    expect(screen.getByLabelText('电话')).toHaveValue('123');
    expect(message.success).not.toHaveBeenCalled();
  });
});

describe('AccountProfileForm 失败与重复提交边界', () => {
  it('transport 类失败展示收敛后的兜底文案，不外泄原始错误信息', async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValue({ kind: 'unhandled-error', message: '网络连接异常，请稍后重试。' });
    renderForm(onSubmit);

    fill('姓名', '新姓名');
    fireEvent.click(getSubmitButton());

    expect(await screen.findByText('网络连接异常，请稍后重试。')).toBeInTheDocument();
    expect(screen.queryByText('fetch failed')).not.toBeInTheDocument();
    expect(message.success).not.toHaveBeenCalled();
  });

  it('同类命令进行中被拒（in-flight）时静默忽略', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ kind: 'in-flight' });
    renderForm(onSubmit);

    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(message.success).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('提交进行中按钮处于 loading 态，重复点击不再触发 onSubmit', () => {
    const onSubmit = vi.fn();
    render(<AccountProfileForm onSubmit={onSubmit} settings={SETTINGS} submitting />);

    fireEvent.click(getSubmitButton());
    fireEvent.click(getSubmitButton());

    expect(getSubmitButton()).toHaveClass('ant-btn-loading');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('AccountProfileForm 编辑版本守卫', () => {
  it('请求进行中继续输入时，陈旧响应不回写覆盖用户输入', async () => {
    const { onSubmit, resolve } = deferredSubmit();
    renderForm(onSubmit);

    fill('昵称', '第一版昵称');
    fireEvent.click(getSubmitButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    fill('昵称', '第二版昵称');
    fill('电话', '13900000000');
    resolve(successResult({ nickname: '第一版昵称', phone: '13800000000' }));

    await waitFor(() => expect(message.success).toHaveBeenCalledWith('基础资料已保存。'));
    expect(screen.getByLabelText('昵称')).toHaveValue('第二版昵称');
    expect(screen.getByLabelText('电话')).toHaveValue('13900000000');
  });

  it('请求期间没有继续输入时，把后端归一结果回写表单（含姓名）', async () => {
    const { onSubmit, resolve } = deferredSubmit();
    renderForm(onSubmit);

    fill('姓名', '  归一姓名  ');
    fill('电话', '');
    fireEvent.click(getSubmitButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    resolve(successResult({ phone: null, realName: '归一姓名' }));

    await waitFor(() => expect(screen.getByLabelText('姓名')).toHaveValue('归一姓名'));
    expect(screen.getByLabelText('电话')).toHaveValue('');
  });
});
