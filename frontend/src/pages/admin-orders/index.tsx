// src/pages/admin-orders/index.tsx

import { useNavigate } from 'react-router';

import { AdminRepairRequestsTab } from '@/features/admin-document-database';

import { PageHeader } from '@/shared/ui/page-header';

/**
 * 管理员「工单管理」直达页（任务 04 UI 对齐）。
 *
 * 只做页面装配：复用 admin-document-database feature 已公开的维修申请列表组件；
 * 点击「详情」进入独立维修申请详情页，并从详情返回时恢复筛选与分页。
 * 路由治理沿用 protectedRouteLoader + /admin/** 角色策略，不新增权限判断。
 */
export function AdminOrdersPage() {
  const navigate = useNavigate();

  return (
    <div className="kb-page">
      <PageHeader
        description="查看全部维修工单的接单、处理与结单状态；进入独立详情页可查看过程、回复与修订历史，并修订工单。"
        eyebrow="Work Orders"
        title="工单管理"
        variant="knowledge-base"
      />
      <AdminRepairRequestsTab
        onOpenDetail={(requestId) => navigate(`/admin/orders/${requestId}`)}
        viewStateKey="admin-orders-list-view"
      />
    </div>
  );
}

export { AdminOrderDetailPage } from './detail';
