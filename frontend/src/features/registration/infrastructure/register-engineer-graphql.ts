// src/features/registration/infrastructure/register-engineer-graphql.ts

/**
 * 工程师注册 GraphQL adapter（公开写）。
 *
 * - 复用 shared/graphql 的 executeGraphQL，以 `authMode: 'none'` 发送公开请求，
 *   不携带任何登录态；成功后由页面展示待审结果区，不创建会话；
 * - 只接受名单内公司 ID：手填名称分支由服务端拒绝，adapter 不提供该入口；
 * - 原始 DTO 与 operation 只停留在本目录，对外返回 feature 内部模型。
 */

import { executeGraphQL } from '@/shared/graphql';

const REGISTER_ENGINEER_MUTATION = `
  mutation RegisterEngineer($input: RegisterInput!) {
    register(input: $input) {
      success
      message
      accountId
      registrationStatus
      applicationId
    }
  }
`;

export type RegisterEngineerMutationInput = {
  realName: string;
  phone: string;
  loginEmail: string;
  loginPassword: string;
  loginName?: string;
  nickname?: string;
  organizationId: number;
  applicationNote?: string;
};

export type RegisterEngineerMutationResult = {
  success: boolean;
  message: string;
  accountId: number | null;
  applicationId: number | null;
};

type RegisterEngineerMutationData = {
  register: {
    success: boolean;
    message: string;
    accountId?: number | null;
    registrationStatus: string;
    applicationId?: number | null;
  };
};

/** 提交工程师注册（服务端在同一事务内复核公司并落待审申请） */
export async function registerEngineerAccount(
  input: RegisterEngineerMutationInput,
): Promise<RegisterEngineerMutationResult> {
  const data = await executeGraphQL<
    RegisterEngineerMutationData,
    { input: RegisterEngineerMutationInput & { type: 'ENGINEER' } }
  >(
    REGISTER_ENGINEER_MUTATION,
    { input: { ...input, type: 'ENGINEER' } },
    { authMode: 'none', fetchPolicy: 'no-cache' },
  );

  return {
    success: data.register.success,
    message: data.register.message,
    accountId: data.register.accountId ?? null,
    applicationId: data.register.applicationId ?? null,
  };
}
