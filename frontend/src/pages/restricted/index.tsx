// src/pages/restricted/index.tsx

import { Alert } from 'antd';
import { useNavigate } from 'react-router';

import { ChangePasswordForm, useAccountSettings } from '@/features/account-settings';
import {
  type AuthSessionIdentity,
  type AuthSessionRestriction,
  clearSessionAfterPasswordChange,
  sampleCurrentAuthSessionIdentity,
  useAuthSession,
} from '@/features/auth-session';

import { PrimaryButton } from '@/shared/ui/buttons';
import { DataCard } from '@/shared/ui/data-card';
import { PageHeader } from '@/shared/ui/page-header';

type RestrictedReason = Exclude<AuthSessionRestriction, 'NONE'>;

// 受限原因文案（只依据后端会话限制状态展示，不在前端推断账号/申请事实）
const RESTRICTION_DETAILS: Record<RestrictedReason, { description: string; title: string }> = {
  MUST_CHANGE_PASSWORD: {
    description: '当前账号需要先修改登录密码，完成后请使用新密码重新登录。',
    title: '请先修改登录密码',
  },
  ENGINEER_PENDING: {
    description: '你的工程师注册申请正在审核中，审核通过后即可访问完整功能。',
    title: '工程师申请审核中',
  },
  ENGINEER_REJECTED: {
    description: '你的工程师注册申请未通过审核，请联系管理员了解详情。',
    title: '工程师申请未通过',
  },
};

/**
 * 受限会话落地页。
 *
 * 路由守卫（protectedRouteLoader + auth-session 策略）只允许 restriction 非 NONE
 * 的会话停留在本页；受限会话访问其他受保护路由时被统一收回这里。
 * 必须改密时复用账号设置的改密表单；改密成功后清理会话并回到登录页，
 * 由后端在下一次登录时按数据库事实重算限制状态（前端不自行改写 restriction）。
 */
export function RestrictedPage() {
  const navigate = useNavigate();
  const { session } = useAuthSession();
  const { isPending, updatePassword } = useAccountSettings({
    // 请求发起前固化会话身份：迟到响应若已不属于当前会话（退出重登 / 切换账号），
    // 不得清理当前会话，与账号设置页同一口径
    sampleSessionIdentity: sampleCurrentAuthSessionIdentity,
  });

  // 防御性分支：正常链路由 loader 保证不会出现；登出瞬间的匿名态落到这里
  if (!session || session.restriction === 'NONE') {
    return (
      <div className="surface-panel">
        <Alert showIcon title="当前会话没有受限访问权限，请重新登录。" type="warning" />
        <div className="page-action-row">
          <PrimaryButton onClick={() => void navigate('/login')}>前往登录</PrimaryButton>
        </div>
      </div>
    );
  }

  const details = RESTRICTION_DETAILS[session.restriction];

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
        description="当前账号处于受限状态，完成必要操作后重新登录即可恢复完整访问。"
        eyebrow="Restricted Session"
        title="账号受限"
      />

      <Alert description={details.description} showIcon title={details.title} type="warning" />

      {session.restriction === 'MUST_CHANGE_PASSWORD' ? (
        <DataCard title="修改登录密码">
          <ChangePasswordForm
            onSubmit={updatePassword}
            onSucceeded={handlePasswordChangeSucceeded}
            submitting={isPending('change-password')}
          />
        </DataCard>
      ) : null}
    </div>
  );
}
