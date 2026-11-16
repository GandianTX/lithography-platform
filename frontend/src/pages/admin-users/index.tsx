// src/pages/admin-users/index.tsx

import { AdminUserManagementPanel } from '@/features/admin-user-management';
import { useAuthSession } from '@/features/auth-session';

import { PageHeader } from '@/shared/ui/page-header';

/**
 * 用户管理页：只负责标题、布局与组合 feature 公开 UI，
 * 业务状态、GraphQL 调用与权限展示策略全部收束在 features/admin-user-management。
 *
 * 会话等级只用于呈现可见范围提示；授权真源在服务端，
 * 一级全范围、二级仅本公司均由服务端按请求期查库结果独立裁决。
 */
export function AdminUsersPage() {
  const sessionState = useAuthSession();
  const adminLevel = sessionState.session?.adminLevel ?? null;

  return (
    <div className="page-stack">
      <PageHeader
        description="查看范围内普通用户账号，按需启用、停用或重置为默认密码。"
        eyebrow="User Management"
        title="用户管理"
      />

      <AdminUserManagementPanel adminLevel={adminLevel} />
    </div>
  );
}
