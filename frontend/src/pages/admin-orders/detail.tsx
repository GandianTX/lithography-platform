// src/pages/admin-orders/detail.tsx

import { Alert } from 'antd';
import { useNavigate, useParams } from 'react-router';

import { AdminRepairRequestDetailPanel } from '@/features/admin-document-database';

import { PageHeader } from '@/shared/ui/page-header';

/**
 * 管理员独立维修申请详情页。
 *
 * 数据读取、权限裁决与修订均复用 admin-document-database 的既有用例；
 * 本页只负责路由参数解析与返回列表，不新增管理员附件写能力。
 */
export function AdminOrderDetailPage() {
  const navigate = useNavigate();
  const { requestId } = useParams<{ requestId: string }>();
  const parsedId = Number(requestId);
  const validId = Number.isInteger(parsedId) && parsedId > 0;

  return (
    <div className="kb-page">
      <PageHeader
        description="查看工单基础信息、处理结果、内部过程、客户回复与修订历史；修订后重新读取服务端详情。"
        eyebrow="Work Orders"
        title="维修申请详情"
        variant="knowledge-base"
      />
      {validId ? (
        <AdminRepairRequestDetailPanel
          onBack={() => navigate('/admin/orders')}
          requestId={parsedId}
        />
      ) : (
        <Alert showIcon title="工单编号无效，请返回工单管理重新选择。" type="error" />
      )}
    </div>
  );
}
