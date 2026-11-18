// src/features/auth-session/ui/session-expired-notice.tsx

import { Alert } from 'antd';

import { useI18n } from '@/shared/i18n';

// 登录页失效提示：仅由登录页按 reason=session-expired 决定是否展示。
// 组件自身无状态，不形成新的全局 Session owner；后续登录错误由
// LoginForm 的反馈通道独立展示，不会被本提示覆盖。
// 常量保留中文默认值，供既有断言复用；实际渲染走当前语言词条。
export const AUTH_SESSION_EXPIRED_NOTICE_MESSAGE = '登录状态已失效，请重新登录';

export type SessionExpiredNoticeProps = {
  visible: boolean;
};

export function SessionExpiredNotice({ visible }: SessionExpiredNoticeProps) {
  const { t } = useI18n();

  if (!visible) {
    return null;
  }

  return <Alert showIcon title={t('auth.sessionExpired')} type="warning" />;
}
