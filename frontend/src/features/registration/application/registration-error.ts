// src/features/registration/application/registration-error.ts

/**
 * 注册失败文案映射的共用实现。
 *
 * 客户与工程师注册的失败语义一致，只有「公司不可用」的可操作建议不同
 * （客户可改手填，工程师只能重新选择）；调用方只覆盖这两条文案，
 * 其余错误码与网络失败处理保持同一口径。
 *
 * 文案只依赖稳定的 `extensions.code` 与业务 `errorCode`
 * （见 docs/api/graphql-error-contract-current.md），不解析自由文本。
 */

import { isGraphQLIngressError, readGraphQLErrorDetail } from '@/shared/graphql';

import { DEFAULT_REGISTER_ERROR_MESSAGE } from './registration-input';

const DUPLICATE_ACCOUNT_MESSAGE = '该登录邮箱或登录名已被注册，请更换后重试。';
const INVALID_INPUT_MESSAGE = '提交信息有误，请检查后重新提交。';

/**
 * 输入归一错误：同一个 errorCode 覆盖邮箱、昵称、姓名、电话、公司等多个字段，
 * 服务端 `extensions.errorMessage` 已指明具体字段，优先直出。
 */
const INPUT_NORMALIZE_ERROR_CODES = new Set([
  'INPUT_NORMALIZE_INVALID_TEXT',
  'INPUT_NORMALIZE_REQUIRED_TEXT_EMPTY',
]);

export type RegistrationErrorMessages = {
  /** 所选公司失效时的可操作提示（各注册类型对后续动作不同） */
  organizationUnavailable: string;
  /** 缺省服务端字段级文案时的公司输入兜底文案 */
  invalidCompanyInput: string;
};

export function resolveRegistrationErrorMessage(
  error: unknown,
  messages: RegistrationErrorMessages,
): string {
  if (!isGraphQLIngressError(error)) {
    return error instanceof Error && error.message.trim()
      ? error.message
      : DEFAULT_REGISTER_ERROR_MESSAGE;
  }

  if (error.type === 'network' || error.type === 'http' || error.type === 'malformed') {
    return error.userMessage;
  }

  const detail = readGraphQLErrorDetail(error);

  if (!detail) {
    return DEFAULT_REGISTER_ERROR_MESSAGE;
  }

  if (detail.errorCode === 'ACCOUNT_ALREADY_EXISTS') {
    return DUPLICATE_ACCOUNT_MESSAGE;
  }

  if (detail.errorCode === 'ACCOUNT_ORGANIZATION_NOT_AVAILABLE') {
    return messages.organizationUnavailable;
  }

  if (detail.errorCode && INPUT_NORMALIZE_ERROR_CODES.has(detail.errorCode)) {
    return detail.errorMessage ?? messages.invalidCompanyInput;
  }

  if (detail.code === 'BAD_USER_INPUT') {
    return detail.errorMessage ?? INVALID_INPUT_MESSAGE;
  }

  return DEFAULT_REGISTER_ERROR_MESSAGE;
}
