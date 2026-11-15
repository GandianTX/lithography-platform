// src/app/layout/engineer-approval-notice.tsx

/**
 * 工程师资格刚生效后的一次性批准提示。
 *
 * 背景：审批通过后服务端每请求复核出的 restriction 变为 NONE，app-layout 的既有
 * 收口会立即把会话从 `/restricted` 送回工程师主页，申请人来不及看到「已通过」。
 * 本组件在受限态按账号落一次性标记，等同一账号的会话变为 NONE 时提示一次，
 * 覆盖当前标签刷新与退出重登；不改任何路由策略。
 *
 * 安全边界：
 * - 标记只决定「是否提示」，不是通行许可；展示与进入都要求服务端确认的 NONE；
 * - 「进入工作台」前再次复核身份，校验失败或仍受限时不导航；
 * - 落点复用 auth-session 的 `resolveAuthSessionHomePath`，不硬编码角色主页。
 */

import { useEffect, useState } from 'react';
import { Alert } from 'antd';
import { useNavigate } from 'react-router';

import { useI18n } from '@/app/providers';

import {
  getCurrentAuthSession,
  refreshCurrentAuthSessionIdentity,
  resolveAuthSessionHomePath,
  sampleCurrentAuthSessionIdentity,
  useAuthSession,
} from '@/features/auth-session';

import { PrimaryButton } from '@/shared/ui/buttons';

import {
  clearPendingEngineerApproval,
  hasPendingEngineerApproval,
  markEngineerApprovalPending,
} from './engineer-approval-notice-storage';

export function EngineerApprovalNotice() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { session } = useAuthSession();
  const accountId = session?.accountId ?? null;
  const restriction = session?.restriction ?? null;
  // 仅用于清除标记后触发一次重渲染；提示是否可见始终由标记与限制态推导，
  // 不额外记录「已关闭账号」，避免同一账号再次受限→恢复时被本次会话永久压制。
  const [, forceRender] = useState(0);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const isRestricted = restriction === 'ENGINEER_PENDING' || restriction === 'ENGINEER_INACTIVE';

  // 受限态只落一次性标记（副作用）。是否展示在渲染期由「当前限制态 + 标记」推导，
  // 不在 effect 内同步 setState，避免级联渲染。
  useEffect(() => {
    if (accountId !== null && isRestricted) {
      markEngineerApprovalPending(accountId);
    }
  }, [accountId, isRestricted]);

  const isVisible =
    accountId !== null && restriction === 'NONE' && hasPendingEngineerApproval(accountId);

  if (!isVisible) {
    return null;
  }

  function dismiss(): void {
    if (accountId !== null) {
      clearPendingEngineerApproval(accountId);
    }
    setVerifyError(null);
    forceRender((current) => current + 1);
  }

  async function handleEnterWorkspace(): Promise<void> {
    const initiatedIdentity = sampleCurrentAuthSessionIdentity();
    setIsVerifying(true);
    setVerifyError(null);

    try {
      await refreshCurrentAuthSessionIdentity();
    } catch {
      setVerifyError(t('layout.approval.verifyFailed'));
      setIsVerifying(false);
      return;
    }

    const current = getCurrentAuthSession();
    if (
      initiatedIdentity === null ||
      current === null ||
      current.accountId !== initiatedIdentity.accountId ||
      current.restriction !== 'NONE'
    ) {
      setVerifyError(t('layout.approval.stillRestricted'));
      setIsVerifying(false);
      return;
    }

    clearPendingEngineerApproval(current.accountId);
    setIsVerifying(false);
    forceRender((value) => value + 1);
    navigate(resolveAuthSessionHomePath(current.role), { replace: true });
  }

  return (
    <div className="mb-4">
      <Alert
        action={
          <PrimaryButton
            loading={isVerifying}
            onClick={() => void handleEnterWorkspace()}
            size="small"
          >
            {t('layout.approval.enter')}
          </PrimaryButton>
        }
        closable={{ closeIcon: true, onClose: dismiss }}
        description={verifyError ?? t('layout.approval.description')}
        showIcon
        title={t('layout.approval.title')}
        type="success"
      />
    </div>
  );
}
