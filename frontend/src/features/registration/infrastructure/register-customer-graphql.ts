// src/features/registration/infrastructure/register-customer-graphql.ts

/**
 * 客户注册 GraphQL adapter（公开写）。
 *
 * - 复用 shared/graphql 的 executeGraphQL，以 `authMode: 'none'` 发送公开请求，
 *   不携带任何登录态；
 * - 公司分支由调用方构造为互斥参数：选择名单公司只传 `organizationId`，
 *   手填自家公司只传 `organizationName`；本 adapter 不推断业务规则；
 * - 原始 DTO 与 operation 只停留在本目录，对外返回 feature 内部模型。
 */

import { executeGraphQL } from '@/shared/graphql';

const REGISTER_CUSTOMER_MUTATION = `
  mutation RegisterCustomer($input: RegisterInput!) {
    register(input: $input) {
      success
      message
      accountId
      registrationStatus
    }
  }
`;

export type RegisterCustomerMutationInput = {
  loginEmail: string;
  loginPassword: string;
  loginName?: string;
  nickname?: string;
  organizationId?: number;
  organizationName?: string;
};

export type RegisterCustomerMutationResult = {
  success: boolean;
  message: string;
  accountId: number | null;
};

type RegisterCustomerMutationData = {
  register: {
    success: boolean;
    message: string;
    accountId?: number | null;
    registrationStatus: string;
  };
};

/** 提交客户注册（服务端在同一事务内复核公司资格并写入） */
export async function registerCustomerAccount(
  input: RegisterCustomerMutationInput,
): Promise<RegisterCustomerMutationResult> {
  const data = await executeGraphQL<
    RegisterCustomerMutationData,
    { input: RegisterCustomerMutationInput & { type: 'CUSTOMER' } }
  >(
    REGISTER_CUSTOMER_MUTATION,
    { input: { ...input, type: 'CUSTOMER' } },
    { authMode: 'none', fetchPolicy: 'no-cache' },
  );

  return {
    success: data.register.success,
    message: data.register.message,
    accountId: data.register.accountId ?? null,
  };
}
