// src/pages/admin/index.tsx

import {
  AuditOutlined,
  FileTextOutlined,
  UnorderedListOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Button } from 'antd';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';

import {
  AuthSessionPanel,
  isAuthSessionAdminPathAllowedAt,
  resolveAuthSessionAdminScope,
  useAuthSession,
} from '@/features/auth-session';

import type { MessageKey } from '@/shared/i18n';
import { useI18n } from '@/shared/i18n';
import { DataCard } from '@/shared/ui/data-card';
import { PageHeader } from '@/shared/ui/page-header';

/**
 * 功能入口卡：目标路由与「当前产品文案」以本地常量登记。可见性由
 * `isAuthSessionAdminPathAllowedAt`（与路由守卫同一判定）统一决定，不在页面里
 * 另写一套角色/等级表。这里只做导航，不新增业务操作、不展示虚构统计。
 */
type AdminEntry = {
  actionKey: MessageKey;
  descriptionKey: MessageKey;
  icon: ReactNode;
  id: string;
  path: string;
  titleKey: MessageKey;
};

const ADMIN_ENTRIES: AdminEntry[] = [
  {
    actionKey: 'admin.users.action',
    descriptionKey: 'admin.users.description',
    icon: <UserOutlined />,
    id: 'admin-users',
    path: '/admin/users',
    titleKey: 'admin.users.title',
  },
  {
    actionKey: 'admin.orders.action',
    descriptionKey: 'admin.orders.description',
    icon: <FileTextOutlined />,
    id: 'admin-orders',
    path: '/admin/orders',
    titleKey: 'admin.orders.title',
  },
  {
    actionKey: 'admin.documents.action',
    descriptionKey: 'admin.documents.description',
    icon: <UnorderedListOutlined />,
    id: 'admin-document-database',
    path: '/admin/document-database',
    titleKey: 'admin.documents.title',
  },
  {
    actionKey: 'admin.operationRecords.action',
    descriptionKey: 'admin.operationRecords.description',
    icon: <AuditOutlined />,
    id: 'admin-operation-records',
    path: '/admin/operation-records',
    titleKey: 'admin.operationRecords.title',
  },
];

/**
 * 管理员入口页：保留会话信息展示（「当前账号」卡），并按可信管理范围决定
 * 是否提供进入用户管理与文档数据库的导航卡片。页面本身位于 /admin/**，
 * 由路由层既有角色策略保证仅 SUPER_ADMIN 可达。
 */
export function AdminPage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { session } = useAuthSession();
  const adminScope = session ? resolveAuthSessionAdminScope(session) : 'NONE';

  const entryItems = ADMIN_ENTRIES.filter((entry) =>
    isAuthSessionAdminPathAllowedAt(adminScope, entry.path),
  );

  return (
    <div className="page-stack">
      <PageHeader
        description={t('admin.description')}
        eyebrow="ADMIN WORKSPACE"
        title={t('admin.title')}
      />

      <AuthSessionPanel variant="account" />

      {entryItems.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {entryItems.map((entry) => (
            <DataCard key={entry.id}>
              <div className="admin-entry-card">
                <span aria-hidden="true" className="admin-entry-icon">
                  {entry.icon}
                </span>
                <div className="admin-entry-text">
                  <h3 className="admin-entry-title">{t(entry.titleKey)}</h3>
                  <p className="admin-entry-description">{t(entry.descriptionKey)}</p>
                </div>
                <Button type="primary" onClick={() => void navigate(entry.path)}>
                  {t(entry.actionKey)}
                </Button>
              </div>
            </DataCard>
          ))}
        </div>
      ) : (
        <DataCard>
          <p className="admin-entry-description">{t('admin.noneNotice')}</p>
        </DataCard>
      )}
    </div>
  );
}
