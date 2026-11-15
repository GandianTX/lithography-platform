// src/features/registration/application/register-engineer.spec.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { registerEngineerAccountMock } = vi.hoisted(() => ({
  registerEngineerAccountMock: vi.fn(),
}));

vi.mock('../infrastructure/register-engineer-graphql', () => ({
  registerEngineerAccount: registerEngineerAccountMock,
}));

import { GraphQLIngressError } from '@/shared/graphql';

import { resolveRegisterEngineerErrorMessage, submitRegisterEngineer } from './register-engineer';

const BASE_INPUT = {
  realName: ' 陈工 ',
  phone: ' 138-0000-0000 ',
  loginEmail: ' engineer@example.com ',
  loginPassword: 'Str0ng!Passw0rd',
  organizationId: 21,
};

describe('submitRegisterEngineer（工程师注册输入构造）', () => {
  beforeEach(() => {
    registerEngineerAccountMock.mockReset();
    registerEngineerAccountMock.mockResolvedValue({
      success: true,
      message: '申请已提交',
      accountId: 601,
      applicationId: 701,
    });
  });

  it('必填字段去空白后提交，公司固定走名单 ID 分支，空可选字段不下发', async () => {
    await submitRegisterEngineer({
      ...BASE_INPUT,
      loginName: '  ',
      nickname: '   ',
      applicationNote: '   ',
    });

    expect(registerEngineerAccountMock).toHaveBeenCalledWith({
      realName: '陈工',
      phone: '138-0000-0000',
      loginEmail: 'engineer@example.com',
      loginPassword: 'Str0ng!Passw0rd',
      organizationId: 21,
    });
  });

  it('填写的可选字段归一后随请求提交', async () => {
    await submitRegisterEngineer({
      ...BASE_INPUT,
      loginName: ' engineer_chen ',
      nickname: ' 陈工 ',
      applicationNote: ' 五年设备维护经验 ',
    });

    expect(registerEngineerAccountMock).toHaveBeenCalledWith({
      realName: '陈工',
      phone: '138-0000-0000',
      loginEmail: 'engineer@example.com',
      loginPassword: 'Str0ng!Passw0rd',
      loginName: 'engineer_chen',
      nickname: '陈工',
      organizationId: 21,
      applicationNote: '五年设备维护经验',
    });
  });

  it('成功时透传账号与待审申请 ID', async () => {
    await expect(submitRegisterEngineer(BASE_INPUT)).resolves.toEqual({
      accountId: 601,
      applicationId: 701,
    });
  });

  it('服务端返回 success=false 时按业务消息拒绝', async () => {
    registerEngineerAccountMock.mockResolvedValue({
      success: false,
      message: '该登录名已被占用',
      accountId: null,
      applicationId: null,
    });

    await expect(submitRegisterEngineer(BASE_INPUT)).rejects.toThrow('该登录名已被占用');
  });

  it('失败且没有业务消息时使用统一兜底文案', async () => {
    registerEngineerAccountMock.mockResolvedValue({
      success: false,
      message: '',
      accountId: null,
      applicationId: null,
    });

    await expect(submitRegisterEngineer(BASE_INPUT)).rejects.toThrow('注册失败，请稍后重试。');
  });

  it('公司不可用时映射为工程师口径文案（只能重新选择）', () => {
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

    expect(resolveRegisterEngineerErrorMessage(error)).toBe(
      '所选公司当前不可用，请重新选择后重试。',
    );
  });
});
