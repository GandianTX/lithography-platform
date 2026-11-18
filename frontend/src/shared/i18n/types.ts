// src/shared/i18n/types.ts

import type { ZH_CN_MESSAGES } from './messages.zh-CN';

/** 应用支持的界面语言：中文为默认语言，英文为第二语言 */
export type AppLanguage = 'zh-CN' | 'en';

/** 词条键：由中文词条表（唯一键集来源）推导 */
export type MessageKey = keyof typeof ZH_CN_MESSAGES;

/** 插值参数：只支持 `{name}` 形式的简单占位符，不引入 ICU */
export type TranslateParams = Record<string, number | string>;

/** 词条翻译函数：英文缺键在编译期由 `satisfies Record<MessageKey, string>` 拦截 */
export type Translate = (key: MessageKey, params?: TranslateParams) => string;
