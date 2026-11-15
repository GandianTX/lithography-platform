// src/features/account-settings/ui/account-settings-panel.tsx

/**
 * 账号设置面板：「个人资料」与「修改密码」两个标签的组合层。
 *
 * 资料读取状态只影响「个人资料」标签内部的展示（加载 / 失败 / 就绪），
 * 「修改密码」标签始终可用，不依赖设置读取结果。登录名、登录邮箱、公司、角色、
 * 等级、状态与最近变更时间均为只读事实，不提供任何编辑控件。
 *
 * GraphQL 请求收束在 infrastructure，本层只消费 application 的视图状态与命令执行结果；
 * 修改密码成功后的会话收口（清理会话真源并跳转登录页）不落在 feature 内——经
 * `onPasswordChangeSucceeded` 由页面装配层接线，避免 features 之间互相引用。
 */

import { Space, Tabs, Typography } from 'antd';
import type { ReactNode } from 'react';

import { useI18n } from '@/shared/i18n';
import { PrimaryButton } from '@/shared/ui/buttons';
import { DataCard } from '@/shared/ui/data-card';
import { ErrorState } from '@/shared/ui/error-state';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { LoadingState } from '@/shared/ui/loading-state';
import { StatusPill, type StatusPillTone } from '@/shared/ui/status-pill';

import type {
  AccountSettingsStatus,
  AccountSettingsView,
  ChangePasswordSessionIdentity,
} from '../application/account-settings.types';
import { useAccountSettings } from '../application/use-account-settings';

import { AccountProfileForm } from './account-profile-form';
import { ChangePasswordForm } from './change-password-form';
import { CustomerCompanySupplement } from './customer-company-supplement';

/** 状态只读展示的胶囊色调；角色恒用中性色（无褒贬语义） */
const STATUS_PILL_TONES: Record<AccountSettingsStatus, StatusPillTone> = {
  ACTIVE: 'ok',
  BANNED: 'critical',
  DELETED: 'critical',
  INACTIVE: 'neutral',
  PENDING: 'warn',
  SUSPENDED: 'warn',
};

/** 只读事实行：标签 + 值，不渲染任何可编辑控件 */
function ReadonlyField({ children, label }: { children: ReactNode; label: string }) {
  return (
    <Space size={4}>
      <Typography.Text type="secondary">{label}</Typography.Text>
      {children}
    </Space>
  );
}

function ReadonlyValue({ value }: { value: string | null }) {
  return <Typography.Text>{value ?? '—'}</Typography.Text>;
}

/** 账号信息只读区：登录名 / 登录邮箱 / 公司 / 角色 / 等级 / 状态 / 最近变更 */
function AccountSettingsOverview({ settings }: { settings: AccountSettingsView }) {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-2">
      <ReadonlyField label={t('account.field.loginName')}>
        <ReadonlyValue value={settings.loginName} />
      </ReadonlyField>
      <ReadonlyField label={t('account.field.loginEmail')}>
        <ReadonlyValue value={settings.loginEmail} />
      </ReadonlyField>
      <ReadonlyField label={t('account.field.company')}>
        <Typography.Text>{settings.trustedCompanyName ?? t('common.notLinked')}</Typography.Text>
      </ReadonlyField>
      <ReadonlyField label={t('account.field.role')}>
        <StatusPill tone="neutral">{t(`layout.role.${settings.role}`)}</StatusPill>
      </ReadonlyField>
      <ReadonlyField label={t('account.field.adminLevel')}>
        <Typography.Text>
          {settings.adminLevel === null
            ? '—'
            : t('account.adminLevelValue', { level: settings.adminLevel })}
        </Typography.Text>
      </ReadonlyField>
      <ReadonlyField label={t('account.field.status')}>
        <StatusPill tone={STATUS_PILL_TONES[settings.status]}>
          {t(`status.account.${settings.status}`)}
        </StatusPill>
      </ReadonlyField>
      <Typography.Text type="secondary">
        {t('account.field.updatedAt', { time: formatDateTimeText(settings.updatedAt) })}
      </Typography.Text>
    </div>
  );
}

type AccountSettingsPanelProps = {
  /**
   * 是否允许缺归属客户自助补录公司（客户角色 + 正常会话），由页面装配层按会话事实
   * 注入；面板自身不读取会话，也不把该值当作授权依据（服务端仍会裁决）。
   */
  canSupplementCompany?: boolean;
  /**
   * 补录成功且权威视图已写回后的回调（页面装配层借此刷新会话归属事实，
   * 使客户首页 / 报修页按新归属渲染）。
   */
  onCompanySupplemented?: (settings: AccountSettingsView) => void | Promise<void>;
  /**
   * 修改密码成功后的会话收口（登出 + 跳转登录页），由页面装配层提供。
   * 第一参为请求发起前采样固化的会话身份，装配层与当前会话比对后决定是否清理。
   * 身份裁决先于成功提示：返回 `false` 表示身份已不匹配（迟到响应被忽略），
   * 表单对该次响应完全静默、不展示成功提示。
   */
  onPasswordChangeSucceeded?: (
    initiatedIdentity: ChangePasswordSessionIdentity | null,
  ) => boolean | Promise<boolean>;
  /**
   * 资料保存成功且结果未过期时的回调（页面装配层借此把昵称回写会话真源）。
   * 第二参为请求发起前采样的账号 ID（null 表示装配层未接入采样）。
   */
  onProfileSaveSucceeded?: (
    settings: AccountSettingsView,
    expectedAccountId: number | null,
  ) => void;
  /** 请求发起前的账号身份采样（页面装配层注入会话真源读取），见 useAccountSettings */
  sampleAccountId?: () => number | null;
  /** 请求发起前的会话代次采样（页面装配层注入会话真源读取），见 useAccountSettings */
  sampleSessionIdentity?: () => ChangePasswordSessionIdentity | null;
};

export function AccountSettingsPanel({
  canSupplementCompany = false,
  onCompanySupplemented,
  onPasswordChangeSucceeded,
  onProfileSaveSucceeded,
  sampleAccountId,
  sampleSessionIdentity,
}: AccountSettingsPanelProps) {
  const { t } = useI18n();
  const { isPending, reload, state, supplementCompany, updatePassword, updateProfile } =
    useAccountSettings({
      onProfileSaved: onProfileSaveSucceeded,
      sampleAccountId,
      sampleSessionIdentity,
    });

  const profileTab =
    state.status === 'loading' ? (
      <LoadingState label={t('account.loading')} />
    ) : state.status === 'failed' ? (
      <ErrorState
        action={<PrimaryButton onClick={reload}>{t('common.retry')}</PrimaryButton>}
        description={state.message}
        title={t('account.loadFailed')}
      />
    ) : (
      <div className="flex flex-col gap-5">
        <DataCard title={t('account.infoCard')}>
          <AccountSettingsOverview settings={state.settings} />
        </DataCard>

        <DataCard title={t('account.profileCard')}>
          <AccountProfileForm
            onSubmit={updateProfile}
            settings={state.settings}
            submitting={isPending('update-profile')}
          />
        </DataCard>

        <CustomerCompanySupplement
          canSupplement={canSupplementCompany}
          onRefresh={reload}
          onSubmit={supplementCompany}
          onSupplemented={onCompanySupplemented}
          settings={state.settings}
          submitting={isPending('supplement-company')}
        />
      </div>
    );

  return (
    <Tabs
      items={[
        {
          children: profileTab,
          key: 'profile',
          label: t('account.tab.profile'),
        },
        {
          children: (
            <DataCard title={t('account.passwordCard')}>
              <ChangePasswordForm
                onSucceeded={onPasswordChangeSucceeded}
                onSubmit={updatePassword}
                submitting={isPending('change-password')}
              />
            </DataCard>
          ),
          // 改密不依赖资料读取：首屏即挂载，loading / failed 标签切换也不影响
          forceRender: true,
          key: 'password',
          label: t('account.tab.password'),
        },
      ]}
    />
  );
}
