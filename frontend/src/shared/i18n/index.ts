// src/shared/i18n/index.ts

export { I18nContext, type I18nContextValue } from './i18n-context';
export { readStoredLanguage, UI_LANGUAGE_STORAGE_KEY } from './language-preference';
export { EN_MESSAGES } from './messages.en';
export { ZH_CN_MESSAGES } from './messages.zh-CN';
export { getRuntimeLanguage, setRuntimeLanguage, translateNow } from './runtime-translator';
export { APP_MESSAGES, createTranslator, translate } from './translate';
export type { AppLanguage, MessageKey, Translate, TranslateParams } from './types';
export { useI18n } from './use-i18n';
