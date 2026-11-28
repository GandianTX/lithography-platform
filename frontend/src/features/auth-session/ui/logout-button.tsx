// src/features/auth-session/ui/logout-button.tsx

import { useState } from 'react';
import { LogoutOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import { useNavigate } from 'react-router';

import { useI18n } from '@/shared/i18n';
import { useMessageFeedback } from '@/shared/ui/message-feedback';

import { logoutAuthSessionWithSignOut } from '../auth-session-entry';

type LogoutButtonProps = {
  /** 收起态专用：仅渲染图标，可访问名称由 aria-label/Tooltip 提供。 */
  iconOnly?: boolean;
};

/**
 * 退出登录。
 *
 * 顺序语义（浏览器会话开启时）：先请服务端清除 Cookie，成功后才清本地会话与缓存
 * 并广播退出事件。服务端清除失败时**留在原页**、保留本地会话，明确提示
 * 「退出未完成」并把按钮切换成重试态——不能把「本地已清空」说成「已退出」，
 * 否则新标签页仍可能恢复登录。
 */
export function LogoutButton({ iconOnly = false }: LogoutButtonProps = {}) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const notify = useMessageFeedback();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);

  async function handleLogout() {
    if (isLoggingOut) {
      return;
    }

    setIsLoggingOut(true);
    setSignOutFailed(false);

    try {
      const outcome = await logoutAuthSessionWithSignOut();

      if (outcome === 'sign-out-failed') {
        setSignOutFailed(true);
        notify({ type: 'error', text: t('auth.logoutIncomplete') });

        return;
      }
    } catch {
      // 服务端清除已成功、仅缓存清理失败：会话真源已清理，仍回登录页
      // （与既有失效链路同口径），不把用户留在半退出状态。
    } finally {
      setIsLoggingOut(false);
    }

    navigate('/login');
  }

  const label = signOutFailed ? t('auth.logoutRetry') : t('layout.logout');

  const button = (
    <Button
      aria-label={iconOnly ? label : undefined}
      danger={signOutFailed}
      disabled={isLoggingOut}
      icon={iconOnly ? <LogoutOutlined /> : undefined}
      loading={isLoggingOut}
      onClick={() => void handleLogout()}
    >
      {iconOnly ? null : label}
    </Button>
  );

  if (!iconOnly) {
    return signOutFailed ? <Tooltip title={t('auth.logoutIncomplete')}>{button}</Tooltip> : button;
  }

  return (
    <Tooltip title={signOutFailed ? t('auth.logoutIncomplete') : t('layout.logout')}>
      {button}
    </Tooltip>
  );
}
