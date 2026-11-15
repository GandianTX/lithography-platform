// src/shared/i18n/runtime-translator.ts

/**
 * 非 React 上下文的翻译入口（application / infrastructure 的失败兜底文案）。
 *
 * 这些层只产出字符串、不参与渲染，不能调用 `useI18n()`；若把 `t` 作为依赖
 * 传进 hook 的 effect，切语言会连带重发查询（S5 检查轮缺陷）。因此由
 * I18nProvider 把当前语言镜像到本模块，兜底文案在**产生时**按当前语言翻译，
 * 渲染路径仍使用 `useI18n().t`（切语言即时重渲染）。
 *
 * 注意：已经产生的字符串不会随之后的语言切换重译——这一点与后端返回的
 * 业务原文（中文）同口径，属于既有边界。
 */

import { readStoredLanguage } from './language-preference';
import { translate } from './translate';
import type { AppLanguage, MessageKey, TranslateParams } from './types';

let runtimeLanguage: AppLanguage = readStoredLanguage();

/** Provider 挂载与语言切换时同步当前语言 */
export function setRuntimeLanguage(language: AppLanguage): void {
  runtimeLanguage = language;
}

export function getRuntimeLanguage(): AppLanguage {
  return runtimeLanguage;
}

/** 按当前语言翻译词条（供 application / infrastructure 兜底文案使用） */
export function translateNow(key: MessageKey, params?: TranslateParams): string {
  return translate(runtimeLanguage, key, params);
}
