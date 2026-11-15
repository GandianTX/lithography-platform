// src/shared/i18n/messages.spec.ts

/**
 * 词条表与翻译函数单测。
 *
 * 双语一致性靠类型（`satisfies Record<MessageKey, string>`）在编译期拦截，
 * 这里补两类运行期约束：
 * 1. 两表键集 / 占位符集合一一对应，避免「英文键拼错但类型放宽」或占位符错位；
 * 2. `translate` 只做 `{name}` 简单插值，缺参时保留占位符原文。
 */

import { describe, expect, it } from 'vitest';

import { EN_MESSAGES } from './messages.en';
import { ZH_CN_MESSAGES } from './messages.zh-CN';
import { APP_MESSAGES, createTranslator, translate } from './translate';

const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

function collectPlaceholders(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]).sort();
}

describe('i18n 词条表', () => {
  it('中英文键集完全一致', () => {
    expect(Object.keys(EN_MESSAGES).sort()).toEqual(Object.keys(ZH_CN_MESSAGES).sort());
  });

  it('所有词条都是非空字符串', () => {
    for (const [language, messages] of Object.entries(APP_MESSAGES)) {
      for (const [key, value] of Object.entries(messages)) {
        expect(typeof value, `${language}.${key}`).toBe('string');
        expect(value.trim(), `${language}.${key}`).not.toBe('');
      }
    }
  });

  it('同一键在两表中的占位符集合一致', () => {
    for (const key of Object.keys(ZH_CN_MESSAGES) as (keyof typeof ZH_CN_MESSAGES)[]) {
      expect(collectPlaceholders(EN_MESSAGES[key]), key).toEqual(
        collectPlaceholders(ZH_CN_MESSAGES[key]),
      );
    }
  });
});

describe('translate', () => {
  it('按语言返回对应词条', () => {
    expect(translate('zh-CN', 'nav.home.label')).toBe('首页');
    expect(translate('en', 'nav.home.label')).toBe('Home');
  });

  it('替换全部 `{name}` 占位符（数字参数转字符串）', () => {
    expect(translate('zh-CN', 'customer.totalItems', { count: 3 })).toBe('共 3 项');
    expect(translate('en', 'account.companyNameMax', { max: 40 })).toContain('40');
  });

  it('缺失参数时保留占位符原文，便于发现缺参', () => {
    expect(translate('zh-CN', 'customer.totalItems')).toBe('共 {count} 项');
    expect(translate('en', 'account.field.updatedAt', {})).toBe('Last updated: {time}');
  });

  it('createTranslator 固定语言，可脱离 Provider 使用', () => {
    const t = createTranslator('en');

    expect(t('language.groupLabel')).toBe('Interface language');
    expect(t('repairForm.requestNo', { requestNo: 'R-1' })).toBe('Request number: R-1');
  });
});
