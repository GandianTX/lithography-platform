// src/features/registration/ui/register-customer-form.spec.tsx
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GraphQLFormattedError } from 'graphql';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

const { fetchOrganizationsMock, checkNameExistsMock, registerMock } = vi.hoisted(() => ({
  fetchOrganizationsMock: vi.fn(),
  checkNameExistsMock: vi.fn(),
  registerMock: vi.fn(),
}));

vi.mock('../infrastructure/registration-organization-adapter', () => ({
  checkRegistrationOrganizationNameExists: checkNameExistsMock,
  fetchRegistrationOrganizations: fetchOrganizationsMock,
}));
vi.mock('../infrastructure/register-customer-graphql', () => ({
  registerCustomerAccount: registerMock,
}));

import { RegisterCustomerForm } from './register-customer-form';

function renderForm() {
  return render(
    <MemoryRouter>
      <RegisterCustomerForm />
    </MemoryRouter>,
  );
}

function fillBasics() {
  fireEvent.change(screen.getByLabelText('登录邮箱'), {
    target: { value: 'customer@example.com' },
  });
  fireEvent.change(screen.getByLabelText('密码'), {
    target: { value: 'Str0ng!Passw0rd' },
  });
}

function getSubmitButton() {
  return screen.getByRole('button', { name: /注\s*册/ });
}

async function pickOrganization(name: string) {
  const combobox = await screen.findByRole('combobox', { name: '所属公司' });
  await waitFor(() => expect(fetchOrganizationsMock).toHaveBeenCalled());
  fireEvent.mouseDown(combobox);
  fireEvent.click(await screen.findByTitle(name));
}

function getFieldLabelOrder(): string[] {
  const form = screen.getByLabelText('登录邮箱').closest('form') as HTMLFormElement;
  return Array.from(form.querySelectorAll('.ant-form-item-label label')).map(
    (label) => label.textContent?.trim() ?? '',
  );
}

function duplicateAccountError(): GraphQLIngressError {
  return new GraphQLIngressError({
    message: 'duplicate account',
    type: 'graphql',
    graphqlErrors: [
      {
        message: 'duplicate account',
        extensions: {
          code: 'CONFLICT',
          errorCode: 'ACCOUNT_ALREADY_EXISTS',
          errorMessage: '登录邮箱已存在',
        },
      } as unknown as GraphQLFormattedError,
    ],
  });
}

describe('RegisterCustomerForm', () => {
  beforeEach(() => {
    fetchOrganizationsMock.mockReset();
    checkNameExistsMock.mockReset();
    registerMock.mockReset();
    fetchOrganizationsMock.mockResolvedValue({
      items: [
        { id: 11, name: '测试公司' },
        { id: 21, name: '同名公司' },
      ],
      total: 2,
      page: 1,
      pageSize: 20,
    });
    checkNameExistsMock.mockResolvedValue(false);
    registerMock.mockResolvedValue({ success: true, message: '注册成功', accountId: 501 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('字段顺序与 V44 一致，底部为注册并开通与返回登录动作', () => {
    renderForm();

    expect(getFieldLabelOrder()).toEqual([
      '登录邮箱',
      '密码',
      '登录名（选填）',
      '昵称（选填）',
      '所属公司',
      '自家公司名称',
    ]);
    expect(screen.getByRole('button', { name: '注册并开通' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回登录' })).toBeInTheDocument();
  });

  it('选择名单内公司时只提交 organizationId，成功后进入结果区', async () => {
    renderForm();
    fillBasics();
    await pickOrganization('测试公司');

    expect(screen.queryByLabelText('自家公司名称')).not.toBeInTheDocument();

    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(registerMock).toHaveBeenCalledWith({
        loginEmail: 'customer@example.com',
        loginPassword: 'Str0ng!Passw0rd',
        organizationId: 11,
      });
    });
    expect(await screen.findByText('账号已开通，请使用登录邮箱与密码登录。')).toBeInTheDocument();
    expect(screen.getByText('customer@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '前往登录' })).toBeInTheDocument();
  });

  it('清空已选公司后可切回手填分支，只提交 organizationName', async () => {
    renderForm();
    fillBasics();
    await pickOrganization('测试公司');

    expect(screen.queryByLabelText('自家公司名称')).not.toBeInTheDocument();

    const clearIcon = document.querySelector('.ant-select-clear');
    expect(clearIcon).not.toBeNull();
    fireEvent.mouseDown(clearIcon as Element);

    await waitFor(() => {
      expect(screen.getByLabelText('自家公司名称')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('自家公司名称'), {
      target: { value: '自家公司' },
    });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(registerMock).toHaveBeenCalledWith({
        loginEmail: 'customer@example.com',
        loginPassword: 'Str0ng!Passw0rd',
        organizationName: '自家公司',
      });
    });
  });

  it('手填与候选同名的公司时提示不自动合并，但仍按手填分支提交', async () => {
    checkNameExistsMock.mockImplementation(async (name: string) => name === '同名公司');
    renderForm();
    fillBasics();

    fireEvent.change(screen.getByLabelText('自家公司名称'), {
      target: { value: '  同名公司  ' },
    });

    await waitFor(() => {
      expect(
        screen.getByText('发现同名公司，可从名单选择；手填名称不会自动合并。'),
      ).toBeInTheDocument();
    });
    // 提示来自独立精确查询，使用与后端同口径的归一化名称
    expect(checkNameExistsMock).toHaveBeenCalledWith('同名公司');

    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(registerMock).toHaveBeenCalledWith({
        loginEmail: 'customer@example.com',
        loginPassword: 'Str0ng!Passw0rd',
        organizationName: '同名公司',
      });
    });
  });

  it('同名提示不受候选首屏影响：候选未包含目标时独立查询仍命中', async () => {
    // 候选只加载了首屏两条，目标在第 2 页且从未搜索/滚动
    checkNameExistsMock.mockImplementation(async (name: string) => name === '后页公司');
    renderForm();
    fillBasics();

    fireEvent.change(screen.getByLabelText('自家公司名称'), {
      target: { value: '后页公司' },
    });

    await waitFor(() => {
      expect(
        screen.getByText('发现同名公司，可从名单选择；手填名称不会自动合并。'),
      ).toBeInTheDocument();
    });
    expect(fetchOrganizationsMock).toHaveBeenCalledTimes(1);

    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(registerMock).toHaveBeenCalledWith({
        loginEmail: 'customer@example.com',
        loginPassword: 'Str0ng!Passw0rd',
        organizationName: '后页公司',
      });
    });
  });

  it('清空手填名称后同名提示消失且不再提示旧名称', async () => {
    checkNameExistsMock.mockImplementation(async (name: string) => name === '同名公司');
    renderForm();
    fillBasics();

    const nameInput = screen.getByLabelText('自家公司名称');
    fireEvent.change(nameInput, { target: { value: '同名公司' } });
    await waitFor(() => {
      expect(
        screen.getByText('发现同名公司，可从名单选择；手填名称不会自动合并。'),
      ).toBeInTheDocument();
    });

    fireEvent.change(nameInput, { target: { value: '' } });

    await waitFor(() => {
      expect(
        screen.queryByText('发现同名公司，可从名单选择；手填名称不会自动合并。'),
      ).not.toBeInTheDocument();
    });
  });

  it('精确查询失败时按未命中处理，不阻止手填注册提交', async () => {
    checkNameExistsMock.mockRejectedValue(new Error('network down'));
    renderForm();
    fillBasics();

    fireEvent.change(screen.getByLabelText('自家公司名称'), {
      target: { value: '自家公司' },
    });

    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(registerMock).toHaveBeenCalledWith({
        loginEmail: 'customer@example.com',
        loginPassword: 'Str0ng!Passw0rd',
        organizationName: '自家公司',
      });
    });
    expect(
      screen.queryByText('发现同名公司，可从名单选择；手填名称不会自动合并。'),
    ).not.toBeInTheDocument();
  });

  it('未选公司也未填名称时给出可操作提示，不发起请求', async () => {
    renderForm();
    fillBasics();

    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(screen.getByText('请选择所属公司，或填写自家公司名称。')).toBeInTheDocument();
    });
    expect(registerMock).not.toHaveBeenCalled();
  });

  it('失败时保留非敏感输入并清空密码，可修正后重试', async () => {
    registerMock.mockRejectedValueOnce(duplicateAccountError());
    renderForm();
    fillBasics();
    fireEvent.change(screen.getByLabelText('自家公司名称'), {
      target: { value: '自家公司' },
    });

    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(screen.getByText('该登录邮箱或登录名已被注册，请更换后重试。')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('登录邮箱')).toHaveValue('customer@example.com');
    expect(screen.getByLabelText('自家公司名称')).toHaveValue('自家公司');
    expect(screen.getByLabelText('密码')).toHaveValue('');

    registerMock.mockResolvedValueOnce({ success: true, message: '注册成功', accountId: 502 });
    fireEvent.change(screen.getByLabelText('密码'), {
      target: { value: 'Str0ng!Passw0rd2' },
    });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(registerMock).toHaveBeenCalledTimes(2);
    });
  });

  it('输入归一失败时展示服务端定位到的具体字段文案，不误报为公司问题', async () => {
    registerMock.mockRejectedValueOnce(
      new GraphQLIngressError({
        message: 'invalid nickname',
        type: 'graphql',
        graphqlErrors: [
          {
            message: 'invalid nickname',
            extensions: {
              code: 'BAD_USER_INPUT',
              errorCode: 'INPUT_NORMALIZE_INVALID_TEXT',
              errorMessage: '昵称至少 2 个字符',
            },
          } as unknown as GraphQLFormattedError,
        ],
      }),
    );
    renderForm();
    fillBasics();
    fireEvent.change(screen.getByLabelText('自家公司名称'), {
      target: { value: '自家公司' },
    });

    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(screen.getByText('昵称至少 2 个字符')).toBeInTheDocument();
    });
    expect(screen.queryByText('提交信息有误，请检查后重新提交。')).not.toBeInTheDocument();
  });

  it('请求在途时重复提交只放行一次', async () => {
    let resolveRegister: (value: {
      success: boolean;
      message: string;
      accountId: number;
    }) => void = () => {};
    registerMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRegister = resolve;
        }),
    );
    renderForm();
    fillBasics();
    fireEvent.change(screen.getByLabelText('自家公司名称'), {
      target: { value: '自家公司' },
    });

    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(registerMock).toHaveBeenCalledTimes(1);
    });

    const form = screen.getByLabelText('密码').closest('form') as HTMLFormElement;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(registerMock).toHaveBeenCalledTimes(1);
    });

    resolveRegister({ success: true, message: '注册成功', accountId: 501 });

    await waitFor(() => {
      expect(screen.getByText('账号已开通，请使用登录邮箱与密码登录。')).toBeInTheDocument();
    });
  });
});
