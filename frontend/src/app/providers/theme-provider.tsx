// src/app/providers/theme-provider.tsx

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { ConfigProvider } from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';

import { createAppThemeConfig } from '@/app/theme';

import { useI18n } from '@/shared/i18n';
import { MessageFeedbackProvider } from '@/shared/ui/message-feedback';

import { FONT_SCALE_CONFIG, type FontScale } from './theme-constants';
import { ThemeContext } from './use-theme';

function readStoredFontScale(): FontScale {
  try {
    const saved = localStorage.getItem('font-scale');

    if (saved === 'compact' || saved === 'standard' || saved === 'comfortable') {
      return saved;
    }
  } catch {
    return 'standard';
  }

  return 'standard';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { language } = useI18n();
  const [fontScale, setFontScale] = useState<FontScale>(readStoredFontScale);
  const themeConfig = useMemo(
    () => createAppThemeConfig({ fontSize: FONT_SCALE_CONFIG[fontScale].antdFontSize }),
    [fontScale],
  );

  useEffect(() => {
    document.documentElement.style.fontSize = FONT_SCALE_CONFIG[fontScale].htmlFontSize;

    try {
      localStorage.setItem('font-scale', fontScale);
    } catch {
      // Storage can be unavailable in restricted browsers.
    }
  }, [fontScale]);

  return (
    <ThemeContext.Provider value={{ fontScale, setFontScale }}>
      <ConfigProvider locale={language === 'en' ? enUS : zhCN} theme={themeConfig}>
        <MessageFeedbackProvider>{children}</MessageFeedbackProvider>
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}
