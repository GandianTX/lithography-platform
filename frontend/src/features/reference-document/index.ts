// src/features/reference-document/index.ts

// barrel 只导出切片外实际消费的公开 API：页面装配所需的 UI 组件、路径常量、
// 类型展示口径，页面消费的创建流程 hook，以及跨模块读需求仍在的列表/型号查询 adapter。
// application 层其余 hooks（详情 query、详情写路径、型号 query）与 Mock 数据文件、
// reset 隔离函数均为 feature 内部组成块，不进公开出口。
// 收敛说明（review P2-3）：创建流程改由 useReferenceDocumentCreate 在 feature 内装配 concrete
// 写 adapter（GraphQL mutation / REST multipart），故 createReferenceDocument、
// createReferenceDocumentWithFile 不再跨层暴露；详情写路径（update / delete / download）
// 已由 useReferenceDocumentActions 内部装配，其导出保留以维持既有公开面。
// Mock 实现与隔离函数（resetReferenceDocumentMockState）均不进 barrel，
// 仅测试从 mock-adapter 文件直连导入，保持公开 API 面与真实 adapter 一致。
export {
  type ReferenceDocumentCreateInput,
  type ReferenceDocumentCreateSubmitResult,
  useReferenceDocumentCreate,
} from './application/use-reference-document-create';
export type {
  CreateReferenceDocumentInput,
  CreateReferenceDocumentResult,
  CreateReferenceDocumentWithFileInput,
  CreateReferenceDocumentWithFileResult,
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
  ReferenceDocumentTypeOption,
  UpdateReferenceDocumentCasePatch,
  UpdateReferenceDocumentCaseResult,
  UpdateReferenceDocumentPatch,
  UpdateReferenceDocumentResult,
} from './infrastructure/reference-document.types';
export {
  REFERENCE_DOCUMENT_TYPE_LABELS,
  REFERENCE_DOCUMENT_TYPE_OPTIONS,
} from './infrastructure/reference-document.types';
export {
  deleteReferenceDocument,
  fetchReferenceDocument,
  fetchReferenceDocuments,
  fetchReferenceEquipmentModels,
  updateReferenceDocument,
  updateReferenceDocumentCase,
} from './infrastructure/reference-document-adapter';
export { downloadReferenceDocumentFile } from './infrastructure/reference-document-http-adapter';
export { ReferenceDocumentDetailPanel } from './ui/reference-document-detail-panel';
export {
  ReferenceDocumentForm,
  type ReferenceDocumentFormOutput,
  type ReferenceDocumentFormSubmitResult,
} from './ui/reference-document-form';
export { ReferenceDocumentList } from './ui/reference-document-list';
export {
  buildReferenceDocumentDetailPath,
  parseReferenceDocumentIdParam,
  REFERENCE_DOCUMENT_NEW_PATH,
  REFERENCE_DOCUMENTS_LIST_PATH,
} from './ui/reference-document-paths';
