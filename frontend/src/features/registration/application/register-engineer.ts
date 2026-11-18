// src/features/registration/application/register-engineer.ts

/**
 * 工程师注册的输入归一与失败文案映射。
 *
 * - 只接受名单内公司：始终只传 `organizationId`，不提供手填公司分支；
 * - 姓名与联系电话必填，由服务端二次归一与校验；
 * - 失败文案复用客户注册的共用映射，仅覆盖「公司不可用」口径。
 */

import { type Translate, translateNow } from '@/shared/i18n';

import {
  registerEngineerAccount,
  type RegisterEngineerMutationInput,
} from '../infrastructure/register-engineer-graphql';

import { resolveRegistrationErrorMessage } from './registration-error';
import { assertRegistrationSucceeded, normalizeOptionalText } from './registration-input';

export type RegisterEngineerInput = {
  realName: string;
  phone: string;
  loginEmail: string;
  loginPassword: string;
  loginName?: string | null;
  nickname?: string | null;
  /** 名单内公司主键（工程师注册不支持手填公司） */
  organizationId: number;
  applicationNote?: string | null;
};

export type RegisterEngineerResult = {
  accountId: number | null;
  applicationId: number | null;
};

/** 构造提交参数：可选字段空值不下发，公司固定走名单 ID 分支 */
function toMutationInput(input: RegisterEngineerInput): RegisterEngineerMutationInput {
  const loginName = normalizeOptionalText(input.loginName);
  const nickname = normalizeOptionalText(input.nickname);
  const applicationNote = normalizeOptionalText(input.applicationNote);

  return {
    realName: input.realName.trim(),
    phone: input.phone.trim(),
    loginEmail: input.loginEmail.trim(),
    loginPassword: input.loginPassword,
    ...(loginName ? { loginName } : {}),
    ...(nickname ? { nickname } : {}),
    organizationId: input.organizationId,
    ...(applicationNote ? { applicationNote } : {}),
  };
}

/** 提交工程师注册；服务端拒绝时抛出原始 ingress 错误，由文案映射统一收敛 */
export async function submitRegisterEngineer(
  input: RegisterEngineerInput,
): Promise<RegisterEngineerResult> {
  const result = await registerEngineerAccount(toMutationInput(input));

  assertRegistrationSucceeded(result);

  return { accountId: result.accountId, applicationId: result.applicationId };
}

/** 把注册失败转换为可操作文案（已注册 / 公司不可用 / 输入不合法 / 网络失败） */
export function resolveRegisterEngineerErrorMessage(error: unknown, t?: Translate): string {
  return resolveRegistrationErrorMessage(
    error,
    {
      organizationUnavailable:
        t?.('register.companyUnavailable') ?? translateNow('register.companyUnavailable'),
    },
    t,
  );
}
