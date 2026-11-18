// src/features/admin-document-database/index.ts

// PR3 管理员文档数据库 feature 出口：三个数据标签组件、统计 hook 与数据访问 API。
// 参考资料标签按计划表「复用当前 GraphQL/REST 契约」，在页面装配层直接组合
// features/reference-document 公开列表组件（features 不得互相依赖，pages 可以）。
// 共用筛选组件 / 详情 hooks 为内部组成块，不进公开出口。
export { useAdminDocumentStats } from './application/use-admin-document-stats';
export type {
  AdminAiConversationFilter,
  AdminAiConversationListItem,
  AdminAiMessageListItem,
  AdminAiReportDetail,
  AdminAiReportFilter,
  AdminAiReportListItem,
  AdminDocumentDatabaseStats,
  AdminListPage,
  AdminRepairRequestFilter,
  AdminRepairRequestListItem,
  AdminRepairRequestSummary,
} from './infrastructure/admin-document-database.types';
export {
  type AdminDetailResult,
  fetchAdminAiConversations,
  fetchAdminAiMessages,
  fetchAdminAiReports,
  fetchAdminDocumentDatabaseStats,
  fetchAdminEquipmentModelOptions,
  fetchAdminRepairRequests,
  fetchAdminRepairRequestSummary,
} from './infrastructure/admin-document-database-adapter';
export { AdminAiConversationsTab } from './ui/admin-ai-conversations-tab';
export { AdminAiReportsTab } from './ui/admin-ai-reports-tab';
export { AdminRepairRequestDetailPanel } from './ui/admin-repair-request-detail-panel';
export { AdminRepairRequestsTab } from './ui/admin-repair-requests-tab';
