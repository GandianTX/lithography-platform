// src/features/registration/infrastructure/register-customer-graphql.spec.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeGraphQLMock } = vi.hoisted(() => ({ executeGraphQLMock: vi.fn() }));

vi.mock('@/shared/graphql', () => ({ executeGraphQL: executeGraphQLMock }));

import { registerCustomerAccount } from './register-customer-graphql';

describe('registerCustomerAccount（公开客户注册）', () => {
  beforeEach(() => {
    executeGraphQLMock.mockReset();
    executeGraphQLMock.mockResolvedValue({
      registerWeb: {
        success: true,
        message: '注册成功',
        accountId: 501,
        registrationStatus: 'REGISTERED',
      },
    });
  });

  it('以公开请求提交 CUSTOMER 注册，并只透传调用方给定的公司参数', async () => {
    const result = await registerCustomerAccount({
      loginEmail: 'customer@example.com',
      loginPassword: 'Str0ng!Passw0rd',
      organizationId: 11,
    });

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('mutation RegisterCustomer'),
      {
        input: {
          loginEmail: 'customer@example.com',
          loginPassword: 'Str0ng!Passw0rd',
          organizationId: 11,
          type: 'CUSTOMER',
        },
      },
      { authMode: 'none', fetchPolicy: 'no-cache' },
    );
    expect(result).toEqual({ success: true, message: '注册成功', accountId: 501 });
  });

  it('手填公司分支只携带 organizationName', async () => {
    await registerCustomerAccount({
      loginEmail: 'customer@example.com',
      loginPassword: 'Str0ng!Passw0rd',
      organizationName: '自家公司',
    });

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.any(String),
      {
        input: {
          loginEmail: 'customer@example.com',
          loginPassword: 'Str0ng!Passw0rd',
          organizationName: '自家公司',
          type: 'CUSTOMER',
        },
      },
      expect.any(Object),
    );
  });

  it('accountId 缺省时归一为 null', async () => {
    executeGraphQLMock.mockResolvedValue({
      registerWeb: { success: true, message: 'ok', registrationStatus: 'REGISTERED' },
    });

    await expect(
      registerCustomerAccount({
        loginEmail: 'customer@example.com',
        loginPassword: 'Str0ng!Passw0rd',
        organizationId: 11,
      }),
    ).resolves.toEqual({ success: true, message: 'ok', accountId: null });
  });
});
