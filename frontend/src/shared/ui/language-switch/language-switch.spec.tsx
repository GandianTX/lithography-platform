// src/shared/ui/language-switch/language-switch.spec.tsx
// @vitest-environment jsdom

/**
 * 唯一语言切换入口单测。
 *
 * - `inline`：双按钮组，`aria-pressed` 标记当前语言，点击切换；
 * - `icon`：单图标按钮，可访问名称随当前语言本地化（zh→切换到英文 / en→切换到中文）。
 *
 * shared 层禁止依赖 app 层，因此这里用 `I18nContext` 直接装配最小状态容器，
 * 不引入 `I18nProvider`。
 */

import { type ReactNode, useMemo, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { type AppLanguage, createTranslator, I18nContext } from '@/shared/i18n';

import { LanguageSwitch } from './index';

function StatefulI18n({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<AppLanguage>('zh-CN');
  const t = useMemo(() => createTranslator(language), [language]);
  const value = useMemo(() => ({ language, setLanguage, t }), [language, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function renderSwitch(variant?: 'icon' | 'inline') {
  return render(
    <StatefulI18n>
      <LanguageSwitch variant={variant} />
    </StatefulI18n>,
  );
}

afterEach(cleanup);

// AntD 会在两个中文字符之间自动插入空格，按钮可访问名称按正则匹配。
const CHINESE_BUTTON = /^中\s*文$/;

describe('LanguageSwitch（inline）', () => {
  it('渲染双按钮组并以 aria-pressed 标记当前语言', () => {
    renderSwitch();

    expect(screen.getByRole('group', { name: '界面语言' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: CHINESE_BUTTON })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('点击 English 切换语言并转移 aria-pressed', () => {
    renderSwitch();

    fireEvent.click(screen.getByRole('button', { name: 'English' }));

    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: CHINESE_BUTTON })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // 组名随语言本地化
    expect(screen.getByRole('group', { name: 'Interface language' })).toBeInTheDocument();
  });

  it('两个按钮都带 lang 标注，便于浏览器按语言选择字体', () => {
    renderSwitch();

    expect(screen.getByRole('button', { name: CHINESE_BUTTON })).toHaveAttribute('lang', 'zh-CN');
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('lang', 'en');
  });

  it('切换后焦点回到被激活的同一个按钮（键盘可继续操作）', () => {
    renderSwitch();

    const englishButton = screen.getByRole('button', { name: 'English' });
    englishButton.focus();
    fireEvent.click(englishButton);

    // text / primary 之间换样式会让按钮节点被重建；更新完成后焦点必须回到新节点
    const switchedButton = screen.getByRole('button', { name: 'English' });
    expect(switchedButton).toHaveAttribute('aria-pressed', 'true');
    expect(document.activeElement).toBe(switchedButton);
  });
});

describe('LanguageSwitch（icon）', () => {
  it('中文态可访问名称为「切换到英文」，点击后切到英文', () => {
    renderSwitch('icon');

    fireEvent.click(screen.getByRole('button', { name: '切换到英文' }));

    // 切换后按钮的可访问名称随界面语言本地化
    expect(screen.getByRole('button', { name: 'Switch to Chinese' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '切换到英文' })).not.toBeInTheDocument();
  });

  it('任意态只渲染一个按钮', () => {
    renderSwitch('icon');

    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('切换后焦点回到图标按钮（窄屏折叠侧栏的键盘入口）', () => {
    renderSwitch('icon');

    const iconButton = screen.getByRole('button', { name: '切换到英文' });
    iconButton.focus();
    fireEvent.click(iconButton);

    expect(document.activeElement).toBe(iconButton);
    expect(iconButton).toHaveAccessibleName('Switch to Chinese');
  });
});
