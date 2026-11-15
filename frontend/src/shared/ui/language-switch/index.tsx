// src/shared/ui/language-switch/index.tsx

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

/**
 * 唯一语言切换入口（V44 语言区口径）。
 *
 * - 两个原生 Button 组成 `role="group"`，`aria-pressed` 标记当前语言；
 * - 键盘 Tab 可聚焦、Enter/Space 原生触发切换，焦点环由 AntD 主题承担；
 * - 组件只调用 `setLanguage`，不触达后端、会话、Apollo 或页面表单。
 */
export function LanguageSwitch({ variant = 'inline' }: LanguageSwitchProps) {
  const { language, setLanguage, t } = useI18n();

  if (variant === 'icon') {
    const nextLanguage = language === 'zh-CN' ? 'en' : 'zh-CN';

    return (
      <Button
        aria-label={t(
          nextLanguage === 'en' ? 'language.switchToEnglish' : 'language.switchToChinese',
        )}
        icon={<GlobalOutlined />}
        size="small"
        type="text"
        onClick={() => setLanguage(nextLanguage)}
      />
    );
  }

  return (
    <div aria-label={t('language.groupLabel')} className="language-switch" role="group">
      <Button
        aria-pressed={language === 'zh-CN'}
        lang="zh-CN"
        size="small"
        type={language === 'zh-CN' ? 'primary' : 'text'}
        onClick={() => setLanguage('zh-CN')}
      >
        中文
      </Button>
      <Button
        aria-pressed={language === 'en'}
        lang="en"
        size="small"
        type={language === 'en' ? 'primary' : 'text'}
        onClick={() => setLanguage('en')}
      >
        English
      </Button>
    </div>
  );
}
