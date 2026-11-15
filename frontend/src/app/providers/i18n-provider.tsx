// src/app/providers/i18n-provider.tsx

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import {
  type AppLanguage,
  I18nContext,
  type MessageKey,
  readStoredLanguage,
  setRuntimeLanguage,
  translate,
  type TranslateParams,
  UI_LANGUAGE_STORAGE_KEY,
} from '@/shared/i18n';

/**
 * 语言 Provider：只管理「界面语言偏好」这一件事。
 *
 * - 切换语言不写后端、不重建会话/Apollo/表单，也不触发任何网络请求；
 * - 偏好写入 localStorage 并同步 `<html lang>`（无障碍与 E1 刷新记忆口径）；
 * - `t` 的引用随语言变化，消费组件按需重新渲染。
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<AppLanguage>(readStoredLanguage);

  useEffect(() => {
    document.documentElement.lang = language;
    // 同步非 React 上下文（application / infrastructure 兜底文案）的当前语言
    setRuntimeLanguage(language);

    try {
      localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, language);
    } catch {
      // Storage can be unavailable in restricted browsers.
    }
  }, [language]);

  const t = useCallback(
    (key: MessageKey, params?: TranslateParams) => translate(language, key, params),
    [language],
  );

  const value = useMemo(() => ({ language, setLanguage, t }), [language, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
