// src/pages/account-settings/index.tsx

import { useNavigate } from 'react-router';

import { AccountSettingsPanel } from '@/features/account-settings';
import {
  clearSessionAfterPasswordChange,
  getCurrentAuthSession,
  sampleCurrentAuthSessionIdentity,
  updateCurrentAuthSessionNickname,
} from '@/features/auth-session';

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
 */
export function AccountSettingsPage() {
  const navigate = useNavigate();

  return (
    <div className="page-stack">
      <PageHeader
        description="维护登录凭据、基础资料与登录密码。"
        eyebrow="Account Settings"
        title="账号设置"
      />

      <AccountSettingsPanel
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
