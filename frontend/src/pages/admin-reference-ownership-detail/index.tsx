// src/pages/admin-reference-ownership-detail/index.tsx

import { useParams } from 'react-router';

import { useAuthSession } from '@/features/auth-session';
import {
  parseReferenceDocumentIdParam,
  ReferenceDocumentDetailPanel,
} from '@/features/reference-document';

import { PageHeader } from '@/shared/ui/page-header';

/**
 * 归属待核实详情页（任务 07 R061-01，一级管理员专用入口）。
 *
 * 路由接线与普通资料详情页同模式：从路径参数解析 documentId 后注入页面组件，
 * 面板走 pending-ownership 变体（服务端专用查询，仅 PENDING 条目可读）。
 * 非法参数（非正整数）不发起 GraphQL 请求，直接呈现面板统一 not-found 口径。
 * 详情内的「上传归属管理」即已实现的归属更正（R061-02）：只提交明确核实的
 * 上传者或上传时公司，另一字段不变，原因必填，不预选任何示例值。
 */
export function AdminReferenceOwnershipDetailPage() {
  const { documentId } = useParams();
  const auth = useAuthSession();
  const viewer =
    auth.status === 'authenticated'
      ? { role: auth.session.role, adminLevel: auth.session.adminLevel }
      : { role: null, adminLevel: null };

  return (
    <div className="page-stack">
      <PageHeader
        description="核对资料内容与现有归属线索，确认后通过「上传归属管理」更正归属。"
        eyebrow="Reference Ownership Detail"
        title="归属待核实详情"
      />
      <ReferenceDocumentDetailPanel
        documentId={parseReferenceDocumentIdParam(documentId)}
        variant="pending-ownership"
        viewer={viewer}
      />
    </div>
  );
}
