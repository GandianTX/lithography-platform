// src/pages/admin-reference-ownership/index.tsx

import { PendingOwnershipReferenceDocumentList } from '@/features/reference-document';

import { PageHeader } from '@/shared/ui/page-header';

/**
 * 归属待核实清单页（任务 07 R061-01，一级管理员专用入口）。
 *
 * 路由 /admin/reference-ownership 在 app/router 注册并复用 protectedRouteLoader；
 * 路由策略按 GLOBAL 管理范围守卫（仅一级管理员放行，页面 V6.5 §9.4「异常列表
 * 单独显示……不向普通公司资料库公开」），数据由服务端专用查询按一级身份核验，
 * 与普通资料库列表（/reference-documents）完全分开。
 */
export function AdminReferenceOwnershipPage() {
  return (
    <div className="page-stack">
      <PageHeader
        description="核实上传者或上传时公司不明确的资料：查看现有归属线索并进入详情更正。"
        eyebrow="Reference Ownership Review"
        title="归属待核实"
      />
      <PendingOwnershipReferenceDocumentList />
    </div>
  );
}
