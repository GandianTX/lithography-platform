// src/pages/admin/index.tsx

import { useMemo } from 'react';
import { FileTextOutlined, UnorderedListOutlined, UserOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';

import {
  AuthSessionPanel,
  isAuthSessionRoleAllowedAt,
  useAuthSession,
} from '@/features/auth-session';

import { DataCard } from '@/shared/ui/data-card';
import { PageHeader } from '@/shared/ui/page-header';

/**
 * 功能入口卡：目标路由与「当前产品文案」以本地常量登记，可见性交给
 * `isAuthSessionRoleAllowedAt`（与路由守卫同一判断函数），不在页面里另写一套角色表。
 * 这里只做导航，不新增业务操作、不展示虚构统计或硬编码资料。
 */
type AdminEntry = {
  action: string;
  description: string;
  icon: ReactNode;
  id: string;
  path: string;
  title: string;
};

const ADMIN_ENTRIES: AdminEntry[] = [
  {
    action: '进入用户管理',
    description: '创建账号、维护资料与账号状态。',
    icon: <UserOutlined />,
    id: 'admin-users',
    path: '/admin/users',
    title: '用户管理',
  },
  {
    action: '进入工单管理',
    description: '查看全部维修工单的接单、处理与结单状态，并复用既有详情与修订能力。',
    icon: <FileTextOutlined />,
    id: 'admin-orders',
    path: '/admin/orders',
    title: '工单管理',
  },
  {
    action: '进入文档数据库',
    description: 'SUPER_ADMIN 的数据聚合视图：参考资料、维修申请、AI 会话与 AI 报告。',
    icon: <UnorderedListOutlined />,
    id: 'admin-document-database',
    path: '/admin/document-database',
    title: '文档数据库',
  },
];

/**
 * 管理员入口页：保留会话信息展示（「当前账号」卡），并提供进入用户管理与文档数据库的
 * 导航卡片。页面本身位于 /admin/**，由路由层既有角色策略保证仅 SUPER_ADMIN 可达。
 */
export function AdminPage() {
  const navigate = useNavigate();
  const { session } = useAuthSession();
  const activeRole = session?.role ?? null;

  const entryItems = useMemo(
    () =>
      activeRole === null
        ? []
        : ADMIN_ENTRIES.filter((entry) => isAuthSessionRoleAllowedAt(activeRole, entry.path)),
    [activeRole],
  );

  return (
    <div className="page-stack">
      <PageHeader
        description="欢迎使用光刻维护平台，可从这里进入用户管理和平台资料页面。"
        eyebrow="ADMIN WORKSPACE"
        title="管理员工作台"
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
                  <h3 className="admin-entry-title">{entry.title}</h3>
                  <p className="admin-entry-description">{entry.description}</p>
                </div>
                <Button type="primary" onClick={() => void navigate(entry.path)}>
                  {entry.action}
                </Button>
              </div>
            </DataCard>
          ))}
        </div>
      ) : null}
    </div>
  );
}
