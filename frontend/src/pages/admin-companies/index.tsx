// src/pages/admin-companies/index.tsx

import { AdminCompanyManagementPanel } from '@/features/admin-company-management';
import { useAuthSession } from '@/features/auth-session';

import { PageHeader } from '@/shared/ui/page-header';

/**
 * 公司档案页：只负责标题、布局与组合 feature 公开 UI。
 *
 * 会话等级只用于选择读入口与是否呈现写入口；授权真源在服务端，
 * 等级缺失时按只读名称名单降级，服务端仍会独立拒绝越权调用。
 */
export function AdminCompaniesPage() {
  const sessionState = useAuthSession();
  const adminLevel = sessionState.session?.adminLevel ?? null;

  return (
    <div className="page-stack">
      <PageHeader
        description="维护公司档案、启用状态与维修服务资格。"
        eyebrow="Company Management"
        title="公司档案"
      />

      {/* 身份/等级变化即重挂载：在途请求与短生命周期凭据 state 一并丢弃 */}
      <AdminCompanyManagementPanel key={adminLevel ?? 'none'} adminLevel={adminLevel} />
    </div>
  );
}
