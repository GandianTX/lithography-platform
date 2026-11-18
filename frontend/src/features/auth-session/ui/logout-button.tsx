// src/features/auth-session/ui/logout-button.tsx

import { useState } from 'react';
import { LogoutOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import { useNavigate } from 'react-router';

import { useI18n } from '@/shared/i18n';

import { logoutAuthSession } from '../auth-session-entry';

type LogoutButtonProps = {
  /** 收起态专用：仅渲染图标，可访问名称由 aria-label/Tooltip 提供。 */
  iconOnly?: boolean;
};

export function LogoutButton({ iconOnly = false }: LogoutButtonProps = {}) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  async function handleLogout() {
    if (isLoggingOut) {
      return;
    }

    setIsLoggingOut(true);

    try {
      await logoutAuthSession();
    } catch {
      // 清理失败不应阻断回到登录页；会话状态交由失效链路收敛。
    }

    navigate('/login');
  }

  const button = (
    <Button
      aria-label={iconOnly ? t('layout.logout') : undefined}
      disabled={isLoggingOut}
      icon={iconOnly ? <LogoutOutlined /> : undefined}
      loading={isLoggingOut}
      onClick={() => void handleLogout()}
    >
      {iconOnly ? null : t('layout.logout')}
    </Button>
  );

  return iconOnly ? <Tooltip title={t('layout.logout')}>{button}</Tooltip> : button;
}
