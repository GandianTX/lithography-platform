// src/features/reference-document/index.ts

// barrel 只导出切片外实际消费的公开 API：页面装配所需的 UI 组件、路径常量、
// 类型展示口径，以及跨模块读需求仍在的列表/型号查询 adapter。
// application 层其余 hooks（详情 query、详情写路径、型号 query）与 Mock 数据文件、
// reset 隔离函数均为 feature 内部组成块，不进公开出口。
//
// 任务 07 确认需求收口：创建流程（useReferenceDocumentCreate / ReferenceDocumentForm /
// reference-document-new 页面）与通用编辑（useReferenceDocumentActions 的 update 分支）
// 已随服务端写入口一并移除——本期普通资料新增与资料审核取消，历史资料照常授权读取；
// 管理动作（R053/R058–R061）经 adapter 导出，供详情面板按一级管理员/原作者装配。
// Mock 实现与隔离函数（resetReferenceDocumentMockState）均不进 barrel，
// 仅测试从 mock-adapter 文件直连导入，保持公开 API 面与真实 adapter 一致。
export type {
  DeleteReferenceDocumentResult,
  ReferenceDocumentCaseDetail,
  ReferenceDocumentCaseHandlingStatus,
  ReferenceDocumentDetail,
  ReferenceDocumentDetailResult,
  ReferenceDocumentEquipmentModelOption,
  ReferenceDocumentFileDownloadResult,
  ReferenceDocumentIngestMethod,
  ReferenceDocumentListFilter,
  ReferenceDocumentListItem,
  ReferenceDocumentListPage,
  ReferenceDocumentListPagination,
  ReferenceDocumentManagedMutationResult,
  ReferenceDocumentTypeOption,
  ReviseReferenceDocumentPatch,
  UpdateReferenceDocumentCasePatch,
  UpdateReferenceDocumentCaseResult,
} from './infrastructure/reference-document.types';
export {
  REFERENCE_DOCUMENT_TYPE_LABELS,
  REFERENCE_DOCUMENT_TYPE_OPTIONS,
} from './infrastructure/reference-document.types';
export {
  adminDeleteReferenceDocument,
  correctReferenceDocumentOwnership,
  deleteReferenceDocument,
  fetchReferenceDocument,
  fetchReferenceDocumentEditableContent,
  fetchReferenceDocuments,
  fetchReferenceEquipmentModels,
  offlineReferenceDocument,
  reviseReferenceDocument,
  reviseReferenceDocumentStructured,
  updateReferenceDocumentCase,
} from './infrastructure/reference-document-adapter';
export { downloadReferenceDocumentFile } from './infrastructure/reference-document-http-adapter';
export { PendingOwnershipReferenceDocumentList } from './ui/pending-ownership-list';
export type { ReferenceDocumentViewer } from './ui/reference-document-detail-panel';
export { ReferenceDocumentDetailPanel } from './ui/reference-document-detail-panel';
export { ReferenceDocumentList } from './ui/reference-document-list';
export {
  ADMIN_PENDING_OWNERSHIP_LIST_PATH,
  buildPendingOwnershipDetailPath,
  buildReferenceDocumentDetailPath,
  parseReferenceDocumentIdParam,
  REFERENCE_DOCUMENTS_LIST_PATH,
} from './ui/reference-document-paths';
export { ReferenceDocumentRevisePanel } from './ui/reference-document-revise-panel';
