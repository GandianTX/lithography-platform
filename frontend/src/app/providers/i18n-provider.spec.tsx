// src/app/providers/i18n-provider.spec.tsx
// @vitest-environment jsdom

/**
 * 语言 Provider 单测（S5 语言区口径）。
 *
 * 覆盖四件事：
 * 1. 首次访问默认中文，`<html lang>` 与 localStorage 同步；
 * 2. 已存偏好（含非法值）的启动解析；
 * 3. 切换语言只改本地状态与持久化，不触发任何网络请求；
 * 4. 存储不可用时静默回落中文，不阻塞渲染。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getRuntimeLanguage, translateNow, UI_LANGUAGE_STORAGE_KEY, useI18n } from '@/shared/i18n';

import { I18nProvider } from './i18n-provider';

function LanguageProbe() {
  const { language, setLanguage, t } = useI18n();

  return (
    <>
      <span data-testid="language">{language}</span>
      <span data-testid="home-label">{t('nav.home.label')}</span>
      <button onClick={() => setLanguage('en')} type="button">
        切到英文
      </button>
    </>
  );
}

function renderProvider() {
  return render(
    <I18nProvider>
      <LanguageProbe />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.lang = '';
  vi.restoreAllMocks();
});

describe('I18nProvider', () => {
  it('首次访问：默认中文，同步 <html lang> 并写入默认偏好', async () => {
    renderProvider();

    expect(screen.getByTestId('language')).toHaveTextContent('zh-CN');
    expect(screen.getByTestId('home-label')).toHaveTextContent('首页');

    await waitFor(() => expect(document.documentElement.lang).toBe('zh-CN'));
    expect(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('zh-CN');
  });

  it('启动时读取已存英文偏好', () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'en');
    renderProvider();

    expect(screen.getByTestId('language')).toHaveTextContent('en');
    expect(screen.getByTestId('home-label')).toHaveTextContent('Home');
    expect(document.documentElement.lang).toBe('en');
  });

  it.each(['fr', '', 'zh', 'EN'])('非法存储值 %j 回落中文', (stored) => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, stored);
    renderProvider();

    expect(screen.getByTestId('language')).toHaveTextContent('zh-CN');
  });

  it('切换语言：立即换文案、写回偏好、同步 <html lang>，且不发任何网络请求', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderProvider();

    fireEvent.click(screen.getByRole('button', { name: '切到英文' }));

    expect(screen.getByTestId('language')).toHaveTextContent('en');
    expect(screen.getByTestId('home-label')).toHaveTextContent('Home');
    await waitFor(() => expect(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('en'));
    expect(document.documentElement.lang).toBe('en');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('切换语言同步非 React 上下文的运行时语言（translateNow 兜底文案跟随）', async () => {
    renderProvider();

    // 初始中文：application / infrastructure 的非 React 兜底文案为中文
    expect(translateNow('common.modelsLoadFailed')).toBe('设备型号加载失败，请稍后重试。');

    fireEvent.click(screen.getByRole('button', { name: '切到英文' }));

    await waitFor(() => expect(getRuntimeLanguage()).toBe('en'));
    expect(translateNow('common.modelsLoadFailed')).toBe(
      'Failed to load equipment models. Please try again later.',
    );
  });

  it('存储不可用（读取抛错）时静默回落中文', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    expect(() => renderProvider()).not.toThrow();
    expect(screen.getByTestId('language')).toHaveTextContent('zh-CN');
  });

  it('存储不可用（写入抛错）时切换仍生效，不中断渲染', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    renderProvider();

    expect(() => fireEvent.click(screen.getByRole('button', { name: '切到英文' }))).not.toThrow();
    expect(screen.getByTestId('language')).toHaveTextContent('en');
  });
});
