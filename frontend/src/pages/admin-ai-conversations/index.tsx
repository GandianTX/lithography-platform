// src/pages/admin-ai-conversations/index.tsx

import { AdminAiConversationsTab } from '@/features/admin-document-database';

import { PageHeader } from '@/shared/ui/page-header';

/**
 * AI 会话记录页（任务 05 · S4.1 · R038）
 *
 * 管理员只读入口：一级管理员跨公司、二级管理员仅本公司；只读查看问答记录，
 * 并可导出固定内容版本的 PDF（受控原始 JSON 不在此提供入口）。
 *
 * 与 `/admin/document-database` 的 AI 会话标签的区别：
 * - 文档数据库整体页为一级管理员专属（含参考资料写能力），本页仅承载 AI 会话只读；
 * - 因此本页对一级与二级管理员同时开放，二级的数据范围由**服务端**按本公司裁决。
 */
export function AdminAiConversationsPage() {
  return (
    <div className="kb-page">
      <PageHeader
        description="只读查看工程师 AI 会话与逐轮问答；一级管理员可见全部公司，二级管理员仅本公司。可导出固定版本 PDF。"
        eyebrow="AI Diagnostics"
        title="AI 会话记录"
        variant="knowledge-base"
      />
      <AdminAiConversationsTab />
    </div>
  );
}
