// src/features/registration/application/register-customer.ts

/**
 * 客户注册的输入归一、分支构造与失败文案映射。
 *
 * - 选择名单公司与手填自家公司互斥：前者只传 `organizationId`，后者只传
 *   `organizationName`，不把已选中的公司名重复提交；
 * - 失败文案只依赖稳定的 `extensions.code` 与业务 `errorCode`
 *   （见 docs/api/graphql-error-contract-current.md），不解析自由文本。
 */

import { type Translate, translateNow } from '@/shared/i18n';

import {
  registerCustomerAccount,
  type RegisterCustomerMutationInput,
} from '../infrastructure/register-customer-graphql';

import { resolveRegistrationErrorMessage } from './registration-error';
import { assertRegistrationSucceeded, normalizeOptionalText } from './registration-input';

export type RegisterCustomerInput = {
  loginEmail: string;
  loginPassword: string;
  loginName?: string | null;
  nickname?: string | null;
  /** 名单内公司主键；与 organizationName 互斥 */
  organizationId: number | null;
  /** 手填自家公司名称；与 organizationId 互斥 */
  organizationName: string | null;
};

export type RegisterCustomerResult = {
  accountId: number | null;
};

/** 构造互斥的公司参数：选中公司时忽略手填名称，反之亦然 */
function toMutationInput(input: RegisterCustomerInput): RegisterCustomerMutationInput {
  const loginName = normalizeOptionalText(input.loginName);
  const nickname = normalizeOptionalText(input.nickname);
  const organizationName = normalizeOptionalText(input.organizationName);

  return {
    loginEmail: input.loginEmail.trim(),
    loginPassword: input.loginPassword,
    ...(loginName ? { loginName } : {}),
    ...(nickname ? { nickname } : {}),
    ...(input.organizationId !== null
      ? { organizationId: input.organizationId }
      : organizationName
        ? { organizationName }
        : {}),
  };
}

/** 提交客户注册；服务端拒绝时抛出原始 ingress 错误，由文案映射统一收敛 */
export async function submitRegisterCustomer(
  input: RegisterCustomerInput,
): Promise<RegisterCustomerResult> {
  const result = await registerCustomerAccount(toMutationInput(input));

  assertRegistrationSucceeded(result);

  return { accountId: result.accountId };
}

/** 把注册失败转换为可操作文案（已注册 / 公司不可用 / 输入不合法 / 网络失败） */
export function resolveRegisterCustomerErrorMessage(error: unknown, t?: Translate): string {
  return resolveRegistrationErrorMessage(
    error,
    {
      // 客户注册可改为手填自家公司，因此公司失效文案比工程师注册多一条出路
      organizationUnavailable:
        t?.('register.companyUnavailableCustomer') ??
        translateNow('register.companyUnavailableCustomer'),
    },
    t,
  );
}
