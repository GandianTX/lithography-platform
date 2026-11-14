// src/features/registration/application/register-customer.spec.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { registerCustomerAccountMock } = vi.hoisted(() => ({
  registerCustomerAccountMock: vi.fn(),
}));

vi.mock('../infrastructure/register-customer-graphql', () => ({
  registerCustomerAccount: registerCustomerAccountMock,
}));

import { GraphQLIngressError } from '@/shared/graphql';

import { resolveRegisterCustomerErrorMessage, submitRegisterCustomer } from './register-customer';

const BASE_INPUT = {
  loginEmail: ' customer@example.com ',
  loginPassword: 'Str0ng!Passw0rd',
  organizationId: 11 as number | null,
  organizationName: null as string | null,
};

describe('submitRegisterCustomer（客户注册输入构造）', () => {
  beforeEach(() => {
    registerCustomerAccountMock.mockReset();
    registerCustomerAccountMock.mockResolvedValue({
      success: true,
      message: '注册成功',
      accountId: 501,
    });
  });

  it('选中名单公司时只提交 organizationId，并归一可选字段', async () => {
    await submitRegisterCustomer({
      ...BASE_INPUT,
      loginName: '  customer_a  ',
      nickname: '  小客户  ',
      organizationName: ' 应被忽略的公司 ',
    });

    expect(registerCustomerAccountMock).toHaveBeenCalledWith({
      loginEmail: 'customer@example.com',
      loginPassword: 'Str0ng!Passw0rd',
      loginName: 'customer_a',
      nickname: '小客户',
      organizationId: 11,
    });
  });

  it('未选名单公司时只提交归一后的手填名称，空白可选字段不下发', async () => {
    await submitRegisterCustomer({
      ...BASE_INPUT,
      loginName: '   ',
      nickname: null,
      organizationId: null,
      organizationName: '  自家公司  ',
    });

    expect(registerCustomerAccountMock).toHaveBeenCalledWith({
      loginEmail: 'customer@example.com',
      loginPassword: 'Str0ng!Passw0rd',
      organizationName: '自家公司',
    });
  });

  it('成功时透传服务端账号 ID', async () => {
    await expect(submitRegisterCustomer(BASE_INPUT)).resolves.toEqual({ accountId: 501 });
  });

  it('服务端返回 success=false 时按业务消息拒绝，不返回半成品结果', async () => {
    registerCustomerAccountMock.mockResolvedValue({
      success: false,
      message: '该登录邮箱已注册',
      accountId: null,
    });

    await expect(submitRegisterCustomer(BASE_INPUT)).rejects.toThrow('该登录邮箱已注册');
  });

  it('失败且没有业务消息时使用统一兜底文案', async () => {
    registerCustomerAccountMock.mockResolvedValue({
      success: false,
      message: '',
      accountId: null,
    });

    await expect(submitRegisterCustomer(BASE_INPUT)).rejects.toThrow('注册失败，请稍后重试。');
  });

  it('公司不可用时映射为客户可操作文案（可改为手填自家公司）', () => {
    const error = new GraphQLIngressError({
      type: 'graphql',
      message: 'internal detail',
      graphqlErrors: [
        {
          message: 'internal detail',
          extensions: {
            code: 'BAD_USER_INPUT',
            errorCode: 'ACCOUNT_ORGANIZATION_NOT_AVAILABLE',
          },
        },
      ],
    });

    expect(resolveRegisterCustomerErrorMessage(error)).toBe(
      '所选公司当前不可用，请重新选择或改为填写自家公司名称。',
    );
  });
});
