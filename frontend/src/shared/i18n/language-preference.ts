// src/shared/i18n/language-preference.ts

import type { AppLanguage } from './types';

/** 语言偏好存储键：与字号偏好 `font-scale` 并列，读写都做白名单校验 */
export const UI_LANGUAGE_STORAGE_KEY = 'ui-language';

function isAppLanguage(value: string | null): value is AppLanguage {
  return value === 'zh-CN' || value === 'en';
}

/** 首次访问（无存储）默认中文；存储不可用或值非法时同样回落中文 */
export function readStoredLanguage(): AppLanguage {
  try {
    const saved = localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);

    if (isAppLanguage(saved)) {
      return saved;
    }
  } catch {
    // Storage can be unavailable in restricted browsers.
  }

  return 'zh-CN';
}
