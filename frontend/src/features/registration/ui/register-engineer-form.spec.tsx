// src/features/registration/ui/register-engineer-form.spec.tsx
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GraphQLFormattedError } from 'graphql';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

const { fetchOrganizationsMock, registerMock } = vi.hoisted(() => ({
  fetchOrganizationsMock: vi.fn(),
  registerMock: vi.fn(),
}));

vi.mock('../infrastructure/registration-organization-adapter', () => ({
  fetchRegistrationOrganizations: fetchOrganizationsMock,
}));
vi.mock('../infrastructure/register-engineer-graphql', () => ({
  registerEngineerAccount: registerMock,
}));

import { RegisterEngineerForm } from './register-engineer-form';

function renderForm() {
  return render(
    <MemoryRouter>
      <RegisterEngineerForm />
    </MemoryRouter>,
  );
}

function fillBasics() {
  fireEvent.change(screen.getByLabelText('姓名'), { target: { value: ' 张三 ' } });
  fireEvent.change(screen.getByLabelText('联系电话'), { target: { value: '138-0013-8000' } });
  fireEvent.change(screen.getByLabelText('登录邮箱'), {
    target: { value: 'engineer@example.com' },
  });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'Str0ng!Passw0rd' } });
}

function getSubmitButton() {
  return screen.getByRole('button', { name: /提交注册申请/ });
}

async function pickOrganization(name: string) {
  const combobox = await screen.findByRole('combobox', { name: '所属公司' });
  await waitFor(() => expect(fetchOrganizationsMock).toHaveBeenCalled());
  fireEvent.mouseDown(combobox);
  fireEvent.click(await screen.findByTitle(name));
}

describe('RegisterEngineerForm', () => {
  beforeEach(() => {
    fetchOrganizationsMock.mockReset();
    registerMock.mockReset();
    fetchOrganizationsMock.mockResolvedValue({
      items: [{ id: 11, name: '测试公司' }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    registerMock.mockResolvedValue({
      success: true,
      message: '注册申请已提交',
      accountId: 601,
      applicationId: 9001,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('姓名与联系电话必填，未填写时不发起请求', async () => {
    renderForm();
    await pickOrganization('测试公司');

    fireEvent.change(screen.getByLabelText('登录邮箱'), {
      target: { value: 'engineer@example.com' },
    });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'Str0ng!Passw0rd' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(screen.getByText('请输入姓名。')).toBeTruthy();
      expect(screen.getByText('请输入联系电话。')).toBeTruthy();
    });
    expect(registerMock).not.toHaveBeenCalled();
  });

  it('不提供手填自家公司字段，公司只能从名单选择', async () => {
    renderForm();
    await pickOrganization('测试公司');

    expect(screen.queryByLabelText('自家公司名称')).toBeNull();
  });

  it('提交后只传名单公司，并显示待审结果区且不创建会话', async () => {
    renderForm();
    fillBasics();
    fireEvent.change(screen.getByLabelText('申请说明（选填）'), {
      target: { value: '  希望加入组织  ' },
    });
    await pickOrganization('测试公司');
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(registerMock).toHaveBeenCalledTimes(1));
    expect(registerMock).toHaveBeenCalledWith({
      realName: '张三',
      phone: '138-0013-8000',
      loginEmail: 'engineer@example.com',
      loginPassword: 'Str0ng!Passw0rd',
      organizationId: 11,
      applicationNote: '希望加入组织',
    });
    expect(await screen.findByText('注册申请已提交，等待所属公司管理员审核。')).toBeTruthy();
    expect(screen.getByText('engineer@example.com')).toBeTruthy();
    expect(sessionStorage.length).toBe(0);
  });

  it('公司不可用时给出工程师口径文案，并清空密码、保留其他输入', async () => {
    registerMock.mockRejectedValue(
      new GraphQLIngressError({
        message: 'organization unavailable',
        type: 'graphql',
        graphqlErrors: [
          {
            message: 'organization unavailable',
            extensions: {
              code: 'BAD_USER_INPUT',
              errorCode: 'ACCOUNT_ORGANIZATION_NOT_AVAILABLE',
              errorMessage: '所选公司不存在、已停用或不具备注册资格',
            },
          } as unknown as GraphQLFormattedError,
        ],
      }),
    );

    renderForm();
    fillBasics();
    await pickOrganization('测试公司');
    fireEvent.click(getSubmitButton());

    expect(await screen.findByText('所选公司当前不可用，请重新选择后重试。')).toBeTruthy();
    expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('姓名') as HTMLInputElement).value).toBe(' 张三 ');
    expect((screen.getByLabelText('登录邮箱') as HTMLInputElement).value).toBe(
      'engineer@example.com',
    );
  });

  it('提交处理中阻止连续点击产生多次请求', async () => {
    let resolveRegister: (value: {
      success: boolean;
      message: string;
      accountId: number | null;
      applicationId: number | null;
    }) => void = () => undefined;
    registerMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRegister = resolve;
        }),
    );

    renderForm();
    fillBasics();
    await pickOrganization('测试公司');

    fireEvent.click(getSubmitButton());
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(registerMock).toHaveBeenCalledTimes(1));
    resolveRegister({
      success: true,
      message: '注册申请已提交',
      accountId: 601,
      applicationId: 9001,
    });
    await waitFor(() =>
      expect(screen.getByText('注册申请已提交，等待所属公司管理员审核。')).toBeTruthy(),
    );
  });
});
