// src/pages/session-unavailable/index.tsx

import { useCallback, useState } from 'react';
import { Alert, Space } from 'antd';
import { Link, useNavigate, useSearchParams } from 'react-router';

import {
  composeLoginRedirectPath,
  ensureWebSessionRestored,
  hasCurrentAuthSession,
  readAuthReturnToParam,
  resolveSafeReturnTo,
} from '@/features/auth-session';

import { useI18n } from '@/shared/i18n';
import { PrimaryButton } from '@/shared/ui/buttons';
import { DataCard } from '@/shared/ui/data-card';
import { ErrorState } from '@/shared/ui/error-state';

/**
 * 「暂时无法恢复登录」页。
 *
 * 只在启动恢复**无法确认**会话（网络 / 服务 / 来源配置）时出现：
 * - 不清会话、不跳登录、不把服务故障说成未登录；
 * - 保留安全 returnTo，重试成功后直接回到原页面；
 * - 也可显式选择「用账号重新登录」。
 */
export function SessionUnavailablePage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);

  const returnTo = resolveSafeReturnTo(readAuthReturnToParam(searchParams));

  const handleRetry = useCallback(async () => {
    setIsRetrying(true);
    setRetryFailed(false);

    try {
      const outcome = await ensureWebSessionRestored({ force: true });

      if (outcome === 'restored' || hasCurrentAuthSession()) {
        navigate(returnTo ?? '/', { replace: true });
        return;
      }

      if (outcome === 'absent') {
        navigate(composeLoginRedirectPath(returnTo ?? '/'), { replace: true });
        return;
      }

      setRetryFailed(true);
    } catch {
      setRetryFailed(true);
    } finally {
      setIsRetrying(false);
    }
  }, [navigate, returnTo]);

  return (
    <div className="login-layout">
      <div className="login-panel">
        <DataCard>
          <ErrorState
            title={t('auth.sessionUnavailableTitle')}
            description={t('auth.sessionUnavailableDescription')}
            action={
              <Space direction="vertical" size="middle">
                <PrimaryButton loading={isRetrying} onClick={() => void handleRetry()}>
                  {t('auth.sessionUnavailableRetry')}
                </PrimaryButton>
                <Link to={composeLoginRedirectPath(returnTo ?? '/')}>
                  {t('auth.sessionUnavailableGoLogin')}
                </Link>
              </Space>
            }
          />
          {retryFailed ? (
            <Alert
              type="warning"
              showIcon
              message={t('auth.sessionUnavailableRetryFailed')}
              style={{ marginTop: 16 }}
            />
          ) : null}
        </DataCard>
      </div>
    </div>
  );
}
