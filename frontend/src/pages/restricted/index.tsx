// src/pages/restricted/index.tsx

import { Alert } from 'antd';
import { useNavigate } from 'react-router';

import {
  AccountProfileForm,
  ChangePasswordForm,
  useAccountSettings,
} from '@/features/account-settings';
import {
  type AuthSessionIdentity,
  type AuthSessionRestriction,
  clearSessionAfterPasswordChange,
  getCurrentAuthSession,
  sampleCurrentAuthSessionIdentity,
  updateCurrentAuthSessionNickname,
  useAuthSession,
} from '@/features/auth-session';

import type { MessageKey } from '@/shared/i18n';
import { useI18n } from '@/shared/i18n';
import { PrimaryButton } from '@/shared/ui/buttons';
import { DataCard } from '@/shared/ui/data-card';
import { ErrorState } from '@/shared/ui/error-state';
import { LoadingState } from '@/shared/ui/loading-state';
import { PageHeader } from '@/shared/ui/page-header';

import { RestrictedApplicationCard } from './restricted-application-card';

type RestrictedReason = Exclude<AuthSessionRestriction, 'NONE'>;

// 受限原因文案（只依据后端会话限制状态展示，不在前端推断账号/申请事实）
const RESTRICTION_DETAIL_KEYS: Record<
  RestrictedReason,
  { descriptionKey: MessageKey; titleKey: MessageKey }
> = {
  MUST_CHANGE_PASSWORD: {
    descriptionKey: 'restricted.mustChangePassword.description',
    titleKey: 'restricted.mustChangePassword.title',
  },
  ENGINEER_PENDING: {
    descriptionKey: 'restricted.engineerPending.description',
    titleKey: 'restricted.engineerPending.title',
  },
  ENGINEER_REJECTED: {
    descriptionKey: 'restricted.engineerRejected.description',
    titleKey: 'restricted.engineerRejected.title',
  },
  ENGINEER_INACTIVE: {
    descriptionKey: 'restricted.engineerInactive.description',
    titleKey: 'restricted.engineerInactive.title',
  },
};

/**
 * 受限会话落地页。
 *
 * 路由守卫（protectedRouteLoader + auth-session 策略）只允许 restriction 非 NONE
 * 的会话停留在本页；受限会话访问其他受保护路由时被统一收回这里。
 *
 * - 必须改密：只呈现改密所需的改密表单（改密前不得读写其他账号事实）；
 * - 其余限制态（待审 / 已拒绝 / 资格未生效）：只读展示本人最新申请的
 *   `myEngineerRegistration`，并允许维护昵称、电话、联系邮箱等本人资料与登录密码；
 *   角色、等级、公司与审批状态不提供任何修改入口。
 *
 * 改密成功后清理会话并回到登录页，由后端在下一次登录时按数据库事实重算限制状态
 * （前端不自行改写 restriction）。资料保存成功把权威昵称回写会话真源（侧栏随之更新）。
 */
export function RestrictedPage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { session } = useAuthSession();
  // 强制改密态只开放身份读取与改密：进入该分支不得加载账号资料与申请详情，
  // 因此必须在 hook 调用前判定并按 enabled 关闭资料链路（Hook 顺序保持不变）
  const mustChangePassword = session?.restriction === 'MUST_CHANGE_PASSWORD';
  const { isPending, reload, state, updatePassword, updateProfile } = useAccountSettings({
    enabled: !mustChangePassword,
    // 请求发起前固化会话身份：迟到响应若已不属于当前会话（退出重登 / 切换账号），
    // 不得清理当前会话，与账号设置页同一口径
    sampleAccountId: () => getCurrentAuthSession()?.accountId ?? null,
    sampleSessionIdentity: sampleCurrentAuthSessionIdentity,
    onProfileSaved: (settings, expectedAccountId) => {
      if (expectedAccountId !== null) {
        updateCurrentAuthSessionNickname(expectedAccountId, settings.nickname);
      }
    },
  });

  // 防御性分支：正常链路由 loader 保证不会出现；登出瞬间的匿名态落到这里
  if (!session || session.restriction === 'NONE') {
    return (
      <div className="surface-panel">
        <Alert showIcon title={t('restricted.invalidSession')} type="warning" />
        <div className="page-action-row">
          <PrimaryButton onClick={() => void navigate('/login')}>
            {t('common.goLogin')}
          </PrimaryButton>
        </div>
      </div>
    );
  }

  const details = RESTRICTION_DETAIL_KEYS[session.restriction];

  async function handlePasswordChangeSucceeded(
    initiatedIdentity: AuthSessionIdentity | null,
  ): Promise<boolean> {
    // 身份不匹配（退出重登 / 已切换账号的迟到响应）：忽略，不打断当前会话，
    // 返回 false 让表单对该次响应完全静默
    if (!(await clearSessionAfterPasswordChange(initiatedIdentity))) {
      return false;
    }

    navigate('/login', { replace: true });

    // 由表单展示后端固定安全提示，不重复弹第二条提示
    return true;
  }

  return (
    <div className="page-stack">
      <PageHeader
        description={t('restricted.headerDescription')}
        eyebrow="Restricted Session"
        title={t('restricted.headerTitle')}
      />

      <Alert
        description={t(details.descriptionKey)}
        showIcon
        title={t(details.titleKey)}
        type="warning"
      />

      {mustChangePassword ? (
        <DataCard title={t('restricted.changePasswordCard')}>
          <ChangePasswordForm
            onSubmit={updatePassword}
            onSucceeded={handlePasswordChangeSucceeded}
            submitting={isPending('change-password')}
          />
        </DataCard>
      ) : (
        <>
          <RestrictedApplicationCard />

          {state.status === 'loading' ? (
            <LoadingState label={t('restricted.profileLoading')} />
          ) : null}

          {state.status === 'failed' ? (
            <ErrorState
              action={<PrimaryButton onClick={reload}>{t('common.retry')}</PrimaryButton>}
              description={state.message}
              title={t('restricted.profileLoadFailed')}
            />
          ) : null}

          {state.status === 'ready' ? (
            <DataCard title={t('restricted.profileCard')}>
              <AccountProfileForm
                mode="restricted"
                onSubmit={updateProfile}
                settings={state.settings}
                submitting={isPending('update-profile')}
              />
            </DataCard>
          ) : null}

          <DataCard title={t('restricted.changePasswordCard')}>
            <ChangePasswordForm
              onSubmit={updatePassword}
              onSucceeded={handlePasswordChangeSucceeded}
              submitting={isPending('change-password')}
            />
          </DataCard>
        </>
      )}
    </div>
  );
}
