// src/features/registration/application/registration-error.ts

/**
 * 注册失败文案映射的共用实现。
 *
 * 客户与工程师注册的失败语义一致，只有「公司不可用」的可操作建议不同
 * （客户可改手填，工程师只能重新选择）；调用方只覆盖该文案，
 * 其余错误码与网络失败处理保持同一口径。
 *
 * 主信号是契约稳定的 `extensions.code` 大类码；`extensions.errorCode` 与
 * `extensions.errorMessage` 只在存在时作可选细化，生产环境隐藏后自动回退到大类码文案，
 * 不会失效（见 docs/api/graphql-error-contract-current.md）。
 */

import { isGraphQLIngressError, readGraphQLErrorDetail } from '@/shared/graphql';
import { createTranslator, type Translate } from '@/shared/i18n';

/** 未显式传入翻译器时的中文兜底（保持既有调用方与单测行为不变） */
const DEFAULT_TRANSLATOR = createTranslator('zh-CN');

export type RegistrationErrorMessages = {
  /** 所选公司失效时的可操作提示（各注册类型对后续动作不同） */
  organizationUnavailable: string;
};

export function resolveRegistrationErrorMessage(
  error: unknown,
  messages: RegistrationErrorMessages,
  t: Translate = DEFAULT_TRANSLATOR,
): string {
  if (!isGraphQLIngressError(error)) {
    return error instanceof Error && error.message.trim() ? error.message : t('register.failed');
  }

  if (error.type === 'network' || error.type === 'http' || error.type === 'malformed') {
    return error.userMessage;
  }

  const detail = readGraphQLErrorDetail(error);

  if (!detail) {
    return t('register.failed');
  }

  if (detail.code === 'CONFLICT') {
    return t('register.duplicate');
  }

  if (detail.code === 'BAD_USER_INPUT') {
    // 可选细化：非生产环境可拿到 errorCode，公司失效按注册类型给出不同建议
    if (detail.errorCode === 'ACCOUNT_ORGANIZATION_NOT_AVAILABLE') {
      return messages.organizationUnavailable;
    }

    // 生产环境只保留大类码：字段校验失败（密码强度、格式等）统一用通用输入文案，
    // 不能借用公司文案，否则会把密码问题误报成公司问题
    return detail.errorMessage ?? t('register.invalidInput');
  }

  return t('register.failed');
}
