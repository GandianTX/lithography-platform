// src/app/providers/use-i18n.ts

import { useContext } from 'react';

import { I18nContext } from './i18n-context';

/** 读取界面语言与翻译函数：默认中文上下文，不抛错（见 i18n-context 的默认值说明） */
export function useI18n() {
  return useContext(I18nContext);
}
