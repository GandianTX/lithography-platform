// src/pages/restricted/restricted-application-card.tsx

/**
 * 受限页的「我的工程师申请」卡片。
 *
 * 只读展示本人最新申请：目标公司、状态、提交/审核时间、申请说明与拒绝原因；
 * 数据来自可信会话入口 `myEngineerRegistration`（服务端按会话账号定位，不接受
 * 任何账号或申请 ID）。没有申请记录是正常态，不报错。
 */

import { useState } from 'react';
import { Descriptions, Typography } from 'antd';

import { getCurrentAuthSession, refreshCurrentAuthSessionIdentity } from '@/features/auth-session';
import {
  type EngineerRegistrationStatus,
  useMyEngineerRegistration,
} from '@/features/registration';

import { useI18n } from '@/shared/i18n';
import { PrimaryButton } from '@/shared/ui/buttons';
import { DataCard } from '@/shared/ui/data-card';
import { ErrorState } from '@/shared/ui/error-state';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { LoadingState } from '@/shared/ui/loading-state';
import { StatusPill, type StatusPillTone } from '@/shared/ui/status-pill';

const STATUS_TONES: Record<EngineerRegistrationStatus, StatusPillTone> = {
  APPROVED: 'ok',
  PENDING: 'warn',
  REJECTED: 'critical',
};

export function RestrictedApplicationCard() {
  const { t } = useI18n();
  const { refresh, retry, state } = useMyEngineerRegistration();
  const [isRefreshing, setIsRefreshing] = useState(false);

  /**
   * 显式刷新：先按服务端复核当前会话限制，再决定是否需要重查申请。
   *
   * - 资格刚生效（restriction 变为 NONE）时由 app-layout 的既有收口跳转，
   *   卡片不再读取申请，避免刚批准就多发一次受限查询；
   * - 仍受限（待审 / 拒绝 / 资格无效）时重查申请，让审核决定与拒绝原因更新；
   * - 身份复核失败不污染申请错误态，仍按当前会话事实重查申请。
   */
  async function handleRefresh(): Promise<void> {
    setIsRefreshing(true);
    try {
      const outcome = await refreshCurrentAuthSessionIdentity().catch(() => null);
      const current = getCurrentAuthSession();

      // 本次复核未描述当前会话（无会话 / 并发刷新覆盖 / 迟到 / 已切换账号）：
      // 不用它推断限制状态，仍按当前会话事实重查申请（服务端按会话定位本人申请）
      if (outcome === null || outcome.status === 'stale') {
        if (current !== null) {
          refresh();
        }
        return;
      }

      // 资格刚生效（restriction 变为 NONE）时由 app-layout 的既有收口跳转，
      // 卡片不再读取申请，避免刚批准就多发一次受限查询；
      // 仍受限（待审 / 拒绝 / 资格无效）时重查申请，让审核决定与拒绝原因更新。
      if (current !== null && current.restriction !== 'NONE') {
        refresh();
      }
    } finally {
      setIsRefreshing(false);
    }
  }

  const refreshButton = (
    <PrimaryButton
      loading={isRefreshing || state.status === 'loading'}
      onClick={() => void handleRefresh()}
      size="small"
    >
      {t('restricted.application.refresh')}
    </PrimaryButton>
  );

  if (state.status === 'loading') {
    return (
      <DataCard extra={refreshButton} title={t('restricted.application.title')}>
        <LoadingState label={t('restricted.application.loading')} />
      </DataCard>
    );
  }

  if (state.status === 'failed') {
    return (
      <DataCard extra={refreshButton} title={t('restricted.application.title')}>
        <ErrorState
          action={<PrimaryButton onClick={retry}>{t('common.retry')}</PrimaryButton>}
          description={state.message}
          title={t('restricted.application.loadFailed')}
        />
      </DataCard>
    );
  }

  const { application } = state;
  if (application === null) {
    return (
      <DataCard extra={refreshButton} title={t('restricted.application.title')}>
        <Typography.Text type="secondary">{t('restricted.application.empty')}</Typography.Text>
      </DataCard>
    );
  }

  return (
    <DataCard
      extra={
        <div className="flex items-center gap-2">
          <StatusPill tone={STATUS_TONES[application.status]}>
            {t(`status.registration.${application.status}`)}
          </StatusPill>
          {refreshButton}
        </div>
      }
      title={t('restricted.application.title')}
    >
      <Descriptions bordered column={1} size="small">
        <Descriptions.Item label={t('restricted.application.company')}>
          {application.organizationName ??
            t('restricted.application.companyId', { id: application.organizationId })}
        </Descriptions.Item>
        <Descriptions.Item label={t('restricted.application.note')}>
          {application.applicationNote ?? '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t('restricted.application.submittedAt')}>
          {formatDateTimeText(application.submittedAt)}
        </Descriptions.Item>
        <Descriptions.Item label={t('restricted.application.reviewedAt')}>
          {application.reviewedAt === null ? '—' : formatDateTimeText(application.reviewedAt)}
        </Descriptions.Item>
        {application.reviewComment ? (
          <Descriptions.Item label={t('restricted.application.reviewComment')}>
            {application.reviewComment}
          </Descriptions.Item>
        ) : null}
      </Descriptions>
    </DataCard>
  );
}
