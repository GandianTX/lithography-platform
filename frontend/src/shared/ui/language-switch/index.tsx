// src/shared/ui/language-switch/index.tsx

import { useEffect, useRef } from 'react';
import { GlobalOutlined } from '@ant-design/icons';
import { Button } from 'antd';

import { useI18n } from '@/shared/i18n';

export type LanguageSwitchProps = {
  /**
   * `inline`：展开态侧栏与登录壳层的双按钮组（`button[lang="zh-CN"]` / `button[lang="en"]`）；
   * `icon`：折叠态侧栏的图标入口，仅一个按钮，可访问名称随当前语言本地化。
   */
  variant?: 'icon' | 'inline';
};

type FocusTarget = 'en' | 'icon' | 'zh-CN';

/**
 * 唯一语言切换入口（V44 语言区口径）。
 *
 * - 两个原生 Button 组成 `role="group"`，`aria-pressed` 标记当前语言；
 * - 键盘 Tab 可聚焦、Enter/Space 原生触发切换，焦点环由 AntD 主题承担；
 * - 语言更新会让按钮在 `text` / `primary` 之间换样式，实测焦点在更新中丢失；
 *   切换完成后把焦点放回用户激活的同一个按钮，键盘可继续操作；
 * - 组件只调用 `setLanguage`，不触达后端、会话、Apollo 或页面表单。
 */
export function LanguageSwitch({ variant = 'inline' }: LanguageSwitchProps) {
  const { language, setLanguage, t } = useI18n();
  const zhButtonRef = useRef<HTMLButtonElement | null>(null);
  const enButtonRef = useRef<HTMLButtonElement | null>(null);
  const iconButtonRef = useRef<HTMLButtonElement | null>(null);
  const pendingFocusRef = useRef<FocusTarget | null>(null);

  // 焦点恢复放在语言更新之后执行：此时按钮已带新样式，focus() 不会再次被覆盖
  useEffect(() => {
    const target = pendingFocusRef.current;

    if (target === null) {
      return;
    }

    pendingFocusRef.current = null;

    const ref = target === 'icon' ? iconButtonRef : target === 'en' ? enButtonRef : zhButtonRef;
    ref.current?.focus();
  }, [language]);

  const switchLanguage = (nextLanguage: 'en' | 'zh-CN', target: FocusTarget) => {
    pendingFocusRef.current = target;
    setLanguage(nextLanguage);
  };

  if (variant === 'icon') {
    const nextLanguage = language === 'zh-CN' ? 'en' : 'zh-CN';

    return (
      <Button
        aria-label={t(
          nextLanguage === 'en' ? 'language.switchToEnglish' : 'language.switchToChinese',
        )}
        icon={<GlobalOutlined />}
        ref={iconButtonRef}
        size="small"
        type="text"
        onClick={() => switchLanguage(nextLanguage, 'icon')}
      />
    );
  }

  return (
    <div aria-label={t('language.groupLabel')} className="language-switch" role="group">
      <Button
        aria-pressed={language === 'zh-CN'}
        lang="zh-CN"
        ref={zhButtonRef}
        size="small"
        type={language === 'zh-CN' ? 'primary' : 'text'}
        onClick={() => switchLanguage('zh-CN', 'zh-CN')}
      >
        中文
      </Button>
      <Button
        aria-pressed={language === 'en'}
        lang="en"
        ref={enButtonRef}
        size="small"
        type={language === 'en' ? 'primary' : 'text'}
        onClick={() => switchLanguage('en', 'en')}
      >
        English
      </Button>
    </div>
  );
}
