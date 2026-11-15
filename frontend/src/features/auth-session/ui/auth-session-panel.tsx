// src/features/auth-session/ui/auth-session-panel.tsx

import { useState } from 'react';
import { SettingOutlined } from '@ant-design/icons';
import { Alert, Button, Descriptions, Tag } from 'antd';
import { useNavigate } from 'react-router';

import { useI18n } from '@/shared/i18n';
import { DataCard } from '@/shared/ui/data-card';

import { useAuthSession } from './auth-session-context';
import { LogoutButton } from './logout-button';

type AuthSessionPanelProps = {
  /**
   * 展示形态：
   * - 'default' 保持原有「成功提示 + 会话明细」通用面板，/customer 等页面沿用，视觉不变；
   * - 'account' 为管理员工作台 /admin 的「当前账号」卡：方形头像 + 昵称 + 只读角色标签 +
   *   账号 ID + 跳转既有账号设置路由的快捷入口，不展示成功提示、统计或硬编码资料；
   *   卡内不放退出登录（唯一退出入口是侧栏左下角常驻按钮）。
   * 两种形态共用同一份真实会话来源与防御性分支，不各自维护会话读取逻辑。
   */
  variant?: 'account' | 'default';
};

export function AuthSessionPanel({ variant = 'default' }: AuthSessionPanelProps = {}) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { session, status } = useAuthSession();
  // 记录加载失败的 URL 而不是布尔量：会话换头像后自动重试，不残留失败态
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);

  // 防御性分支：当前只挂载在受 loader 守卫的角色页，理论上不可达；
  // 保留是为了将来复用到非受保护场景时仍给出明确提示而不是空白。
  if (status !== 'authenticated' || !session) {
    return (
      <div className="surface-panel">
        <Alert showIcon title={t('auth.panel.unavailable')} type="warning" />
        <div className="page-action-row">
          <Button type="primary" onClick={() => navigate('/login')}>
            {t('common.goLogin')}
          </Button>
        </div>
      </div>
    );
  }

  if (variant === 'account') {
    const nickname = session.userInfo?.nickname ?? null;
    // 头像来自受保护的本人资料（登录结果已返回该字段）；无真实 URL 或加载失败时回落昵称首字
    const avatarUrl = session.userInfo?.avatarUrl ?? null;
    const showAvatarImage = avatarUrl !== null && failedAvatarUrl !== avatarUrl;

    return (
      <DataCard title={t('auth.panel.accountTitle')}>
        <div className="admin-account">
          <div className="admin-account-identity">
            {showAvatarImage ? (
              <img
                alt=""
                className="user-avatar user-avatar--lg"
                src={avatarUrl ?? undefined}
                onError={() => setFailedAvatarUrl(avatarUrl)}
              />
            ) : (
              /* 方形头像复用公共 .user-avatar 配方（12px 圆角 + 渐变蓝底），不使用圆形头像 */
              <span aria-hidden="true" className="user-avatar user-avatar--lg">
                {(nickname ?? t('layout.userFallback')).trim().charAt(0).toUpperCase()}
              </span>
            )}

            <div className="admin-account-text">
              <span className="admin-account-name">{nickname ?? t('layout.currentUser')}</span>
              {/* 只读角色标签：直接展示会话角色，不提供任何角色编辑入口 */}
              <span className="admin-account-role">
                <Tag color="blue">{session.role}</Tag>
              </span>
              <span className="admin-account-id">
                {t('auth.panel.accountId', { id: session.accountId })}
              </span>
            </div>
          </div>

          {/* 账号设置快捷入口：目标是路由表里已存在的 /account/settings（对全部登录角色开放），
              这里只做导航；本卡不再内嵌退出登录，退出入口只保留侧栏左下角常驻按钮。 */}
          <Button icon={<SettingOutlined />} onClick={() => void navigate('/account/settings')}>
            {t('account.title')}
          </Button>
        </div>
      </DataCard>
    );
  }

  return (
    <div className="surface-panel">
      <div className="flex flex-col gap-4">
        <Alert
          description={t('auth.panel.identity', { role: session.role })}
          showIcon
          title={t('auth.panel.loginSuccess')}
          type="success"
        />

        <Descriptions
          bordered
          column={{ lg: 2, md: 1, sm: 1, xs: 1 }}
          items={[
            {
              children: <Tag color="blue">{session.role}</Tag>,
              key: 'role',
              label: t('auth.panel.role'),
            },
            {
              children: session.accountId,
              key: 'accountId',
              label: t('auth.panel.accountIdLabel'),
            },
            {
              children: session.userInfo?.nickname ?? '—',
              key: 'nickname',
              label: t('auth.panel.nickname'),
            },
            {
              children: session.userInfo ? (
                <div className="flex flex-wrap gap-1">
                  {session.userInfo.accessGroup.map((role) => (
                    <Tag key={role}>{role}</Tag>
                  ))}
                </div>
              ) : (
                '—'
              ),
              key: 'accessGroup',
              label: t('auth.panel.accessGroup'),
            },
          ]}
        />

        <div className="page-action-row">
          <LogoutButton />
        </div>
      </div>
    </div>
  );
}
