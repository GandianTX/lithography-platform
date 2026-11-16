// src/pages/account-settings/index.tsx

import { message } from 'antd';
import { useNavigate } from 'react-router';

import { AccountSettingsPanel } from '@/features/account-settings';
import {
  clearSessionAfterPasswordChange,
  getCurrentAuthSession,
  refreshCurrentAuthSessionIdentity,
  sampleCurrentAuthSessionIdentity,
  updateCurrentAuthSessionNickname,
  useAuthSession,
} from '@/features/auth-session';

import { useI18n } from '@/shared/i18n';
import { PageHeader } from '@/shared/ui/page-header';

/**
 * 账号设置页：只负责页头与组合 feature 公开 UI，以及两条会话侧写的接线。
 *
 * 修改密码会使既有会话失效：仅当「发起改密的那个会话」仍是当前会话（同账号且同
 * 会话代次）时清理 auth-session 的唯一会话真源并跳转登录页；响应在途期间退出重登
 * 或已切换账号的迟到响应被忽略——不清理当前会话、不跳转、也不展示成功提示
 * （身份裁决先于提示，装配层以返回值告知表单是否静默）。身份在**请求发起前**经
 * sampleSessionIdentity 采样固化（不含 Token 的窄身份），缓存清理本身失败不阻塞
 * 跳转（与 LogoutButton 同一口径）。资料保存成功则把权威昵称经窄入口回写会话真源
 * （内存 + sessionStorage 同步），侧栏显示随之更新。资料身份口径：accountId 在
 * **请求发起前**经 sampleAccountId 采样固化，迟到响应携带的仍是发起者身份；
 * store 与当前会话比对不匹配即拒绝，A 发起保存后切换到 B 的场景不会把 A 的昵称
 * 写进 B 的会话。
 *
 * 公司补录的资格与刷新：自助补录只对「客户角色 + 正常会话」开放（受限页本就不渲染
 * 该页面，这里仍按会话事实判断）；补录成功后刷新会话身份，使客户首页 / 报修页按新的
 * `customerOrganizationId` 渲染。身份刷新失败只提示，不回滚已确认的权威视图。
 */
export function AccountSettingsPage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { session, status } = useAuthSession();

  const canSupplementCompany =
    status === 'authenticated' && session.role === 'CUSTOMER' && session.restriction === 'NONE';

  return (
    <div className="page-stack">
      <PageHeader
        description={t('account.description')}
        eyebrow="Account Settings"
        title={t('account.title')}
      />

      <AccountSettingsPanel
        canSupplementCompany={canSupplementCompany}
        onCompanySupplemented={async () => {
          try {
            const outcome = await refreshCurrentAuthSessionIdentity();
            // stale：本次复核不代表当前会话（并发刷新覆盖 / 迟到 / 已切换账号），
            // 不能把页面展示当作已确认，提示用户重新刷新或登录
            if (outcome.status === 'stale') {
              message.warning(t('account.supplementRefreshWarning'));
            }
          } catch {
            // 权威视图已确认更新；会话刷新失败只提示，不推翻页面上已写入的公司事实
            message.warning(t('account.supplementRefreshWarning'));
          }
        }}
        onPasswordChangeSucceeded={async (initiatedIdentity) => {
          // 身份不匹配（退出重登 / 已切换账号的迟到响应）：不打断当前会话，
          // 返回 false 让表单对该次响应完全静默（不展示成功提示）
          if (!(await clearSessionAfterPasswordChange(initiatedIdentity))) {
            return false;
          }

          navigate('/login');

          return true;
        }}
        onProfileSaveSucceeded={(settings, expectedAccountId) => {
          if (expectedAccountId !== null) {
            updateCurrentAuthSessionNickname(expectedAccountId, settings.nickname);
          }
        }}
        sampleAccountId={() => getCurrentAuthSession()?.accountId ?? null}
        sampleSessionIdentity={sampleCurrentAuthSessionIdentity}
      />
    </div>
  );
}
