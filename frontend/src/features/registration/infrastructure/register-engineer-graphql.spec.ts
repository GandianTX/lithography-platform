// src/features/registration/infrastructure/register-engineer-graphql.spec.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeGraphQLMock } = vi.hoisted(() => ({ executeGraphQLMock: vi.fn() }));

vi.mock('@/shared/graphql', () => ({ executeGraphQL: executeGraphQLMock }));

import { registerEngineerAccount } from './register-engineer-graphql';

describe('registerEngineerAccount（公开工程师注册）', () => {
  beforeEach(() => {
    executeGraphQLMock.mockReset();
    executeGraphQLMock.mockResolvedValue({
      register: {
        success: true,
        message: '注册申请已提交',
        accountId: 601,
        registrationStatus: 'PENDING_REVIEW',
        applicationId: 9001,
      },
    });
  });

  it('以公开请求提交 ENGINEER 注册，并透传姓名电话与公司 ID', async () => {
    const result = await registerEngineerAccount({
      realName: '张三',
      phone: '13800138000',
      loginEmail: 'engineer@example.com',
      loginPassword: 'Str0ng!Passw0rd',
      organizationId: 11,
      applicationNote: '希望加入组织',
    });

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('mutation RegisterEngineer'),
      {
        input: {
          realName: '张三',
          phone: '13800138000',
          loginEmail: 'engineer@example.com',
          loginPassword: 'Str0ng!Passw0rd',
          organizationId: 11,
          applicationNote: '希望加入组织',
          type: 'ENGINEER',
        },
      },
      { authMode: 'none', fetchPolicy: 'no-cache' },
    );
    expect(result).toEqual({
      success: true,
      message: '注册申请已提交',
      accountId: 601,
      applicationId: 9001,
    });
  });

  it('accountId / applicationId 缺省时归一为 null', async () => {
    executeGraphQLMock.mockResolvedValue({
      register: { success: true, message: 'ok', registrationStatus: 'PENDING_REVIEW' },
    });

    await expect(
      registerEngineerAccount({
        realName: '张三',
        phone: '13800138000',
        loginEmail: 'engineer@example.com',
        loginPassword: 'Str0ng!Passw0rd',
        organizationId: 11,
      }),
    ).resolves.toEqual({
      success: true,
      message: 'ok',
      accountId: null,
      applicationId: null,
    });
  });
});
