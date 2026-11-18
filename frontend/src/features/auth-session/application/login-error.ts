// src/features/auth-session/application/login-error.ts

import { isGraphQLIngressError } from '@/shared/graphql';
import { createTranslator, type Translate } from '@/shared/i18n';

/** 未显式传入翻译器时的中文兜底（保持既有调用方与单测行为不变） */
const DEFAULT_TRANSLATOR = createTranslator('zh-CN');

export function resolveLoginErrorMessage(
  error: unknown,
  t: Translate = DEFAULT_TRANSLATOR,
): string {
  if (!isGraphQLIngressError(error)) {
    return t('auth.loginFailed');
  }

  if (error.type === 'auth') {
    return t('auth.invalidCredentials');
  }

  if (error.type === 'network' || error.type === 'http' || error.type === 'malformed') {
    return error.userMessage;
  }

  return t('auth.loginFailed');
}
