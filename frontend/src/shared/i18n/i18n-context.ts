// src/shared/i18n/i18n-context.ts

import { createContext } from 'react';

import { createTranslator } from './translate';
import type { AppLanguage, Translate } from './types';

export type I18nContextValue = {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
  t: Translate;
};

/**
 * 默认值固定为中文：
 *
 * - 生产环境始终由 `I18nProvider` 提供真实值（默认语言、偏好持久化、`<html lang>`）；
 * - 组件级单测若只关心中文渲染、不关心切语言，可不挂 Provider 直接渲染，
 *   避免每个既有用例都要补一层容器；行为与「首次访问默认中文」一致。
 */
export const I18nContext = createContext<I18nContextValue>({
  language: 'zh-CN',
  setLanguage: () => undefined,
  t: createTranslator('zh-CN'),
});
