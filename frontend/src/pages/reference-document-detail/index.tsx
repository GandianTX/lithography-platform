// src/pages/reference-document-detail/index.tsx

import { useParams } from 'react-router';

import { useAuthSession } from '@/features/auth-session';
import {
  parseReferenceDocumentIdParam,
  ReferenceDocumentDetailPanel,
} from '@/features/reference-document';

import { PageHeader } from '@/shared/ui/page-header';

/**
 * 参考资料详情页（任务 07）。
 *
 * 路由接线：从路径参数解析 documentId 后注入页面组件，面板保持可独立测试。
 * 非法参数（非正整数：abc/0/负数/小数/空）不发起 GraphQL 请求，
 * 直接呈现面板统一的 not-found 口径（与后端防探测一致）。
 * 会话视角（角色 + 管理员等级）由页面层从 auth-session 映射后注入面板，
 * 仅用于管理操作入口显隐（R053/R058–R061）；授权由服务端最终裁决。
 */
export function ReferenceDocumentDetailPage() {
  const { documentId } = useParams();
  const auth = useAuthSession();
  const viewer =
    auth.status === 'authenticated'
      ? { role: auth.session.role, adminLevel: auth.session.adminLevel }
      : { role: null, adminLevel: null };

  return (
    <div className="page-stack">
      <PageHeader
        description="查阅维护知识资料的完整内容、来源版本与历史版本。"
        eyebrow="Reference Document Detail"
        title="参考资料详情"
      />
      <ReferenceDocumentDetailPanel
        documentId={parseReferenceDocumentIdParam(documentId)}
        viewer={viewer}
      />
    </div>
  );
}
