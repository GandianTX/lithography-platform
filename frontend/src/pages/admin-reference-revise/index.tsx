// src/pages/admin-reference-revise/index.tsx
// 独立管理修订页（任务 07，一级管理员专用入口）：
// 路由治理复用 protectedRouteLoader，/admin/reference-revise 在 auth-session
// 管理路径策略中按 GLOBAL 范围守卫（仅一级放行）；写权限由服务端最终裁决。
// 非法参数（非正整数）不发起 GraphQL 请求，直接呈现面板统一的 not-found 口径。

import { useParams } from 'react-router';

import { useAuthSession } from '@/features/auth-session';
import {
  parseReferenceDocumentIdParam,
  ReferenceDocumentRevisePanel,
} from '@/features/reference-document';

import { useI18n } from '@/shared/i18n';
import { PageHeader } from '@/shared/ui/page-header';

export function AdminReferenceRevisePage() {
  const { documentId } = useParams();
  const { t } = useI18n();
  const auth = useAuthSession();
  const viewer =
    auth.status === 'authenticated'
      ? { role: auth.session.role, adminLevel: auth.session.adminLevel }
      : { role: null, adminLevel: null };

  return (
    <div className="page-stack">
      <PageHeader
        description={t('refDocRevise.page.description')}
        eyebrow="Reference Document Revise"
        title={t('refDocRevise.page.title')}
      />
      <ReferenceDocumentRevisePanel
        documentId={parseReferenceDocumentIdParam(documentId)}
        viewer={viewer}
      />
    </div>
  );
}
