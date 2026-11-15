// src/pages/login/index.tsx

import { Link } from 'react-router';

import type { AuthSessionView } from '@/features/auth-session';
import { LoginForm, SessionExpiredNotice } from '@/features/auth-session';

import { useI18n } from '@/shared/i18n';
import { DataCard } from '@/shared/ui/data-card';

export type LoginPageProps = {
  onAuthenticated?: (session: AuthSessionView) => void;
  // 仅在失效原因为预定义的 session-expired 时由路由层传入；普通访问、
  // 主动退出与未登录访问都不携带失效提示。
  sessionExpired?: boolean;
};

/**
 * 登录页：位于 AppLayout 的登录壳层（精确路由 /login），
 * 整页灰蓝底与左上角品牌由壳层承担，本组件只负责双栏主体——
 * 左栏欢迎文案（主/副标题只在此处出现一次，不在登录卡内重复），
 * 右栏登录表单卡（只保留表单与必要的会话失效提示）。
 * 双栏成组居中并整体略偏页面左侧；窄屏由 CSS 改为纵向堆叠。
 */
export function LoginPage({ onAuthenticated, sessionExpired = false }: LoginPageProps) {
  const { t } = useI18n();

  return (
    <div className="login-layout">
      <div className="login-intro">
        <h1 className="login-intro-title">{t('login.introTitle')}</h1>
        <p className="login-intro-subtitle">{t('login.introSubtitle')}</p>
        {/* 主色短横：标题下的强调线，仅装饰 */}
        <span aria-hidden="true" className="login-intro-rule" />
        <p className="login-intro-note">{t('login.introNote')}</p>
      </div>

      <div className="login-panel">
        <DataCard>
          {sessionExpired ? (
            <div className="login-card-notice">
              <SessionExpiredNotice visible />
            </div>
          ) : null}

          <LoginForm
            onAuthenticated={onAuthenticated}
            secondaryActions={
              <>
                <Link className="login-action-link" to="/register/customer">
                  {t('login.customerRegister')}
                </Link>
                <Link className="login-action-link" to="/register/engineer">
                  {t('login.engineerRegister')}
                </Link>
              </>
            }
          />
        </DataCard>
      </div>
    </div>
  );
}
