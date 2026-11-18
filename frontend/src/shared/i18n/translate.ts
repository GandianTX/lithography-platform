// src/shared/i18n/translate.ts

import { EN_MESSAGES } from './messages.en';
import { ZH_CN_MESSAGES } from './messages.zh-CN';
import type { AppLanguage, MessageKey, Translate, TranslateParams } from './types';

/** 语言 → 词条表；两表键集一致由 messages.en.ts 的 satisfies 约束保证 */
export const APP_MESSAGES: Record<AppLanguage, Record<MessageKey, string>> = {
  'zh-CN': ZH_CN_MESSAGES,
  en: EN_MESSAGES,
};

/**
 * 词条翻译：只做 `{name}` 简单插值。
 * 未提供的占位符保持原样，便于在缺失参数时从界面直接看出键位。
 */
export function translate(
  language: AppLanguage,
  key: MessageKey,
  params?: TranslateParams,
): string {
  const template = APP_MESSAGES[language][key];

  if (!params) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : placeholder,
  );
}

/** 生成某语言的翻译函数（Provider 内使用，保持 t 的引用稳定由 useCallback 负责） */
export function createTranslator(language: AppLanguage): Translate {
  return (key, params) => translate(language, key, params);
}
