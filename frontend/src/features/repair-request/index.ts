// src/features/repair-request/index.ts

// barrel 只导出切片外实际消费的公开 API：
// 工程师首页工作台（Provider / 页头真实统计 / 主体）、工程师列表/详情面板、
// 路径常量与客户创建表单，以及客户列表 / 详情页消费的
// customer application hook（page 只感知 feature 公开入口，不感知 concrete adapter）。
// application 层 hooks（useAcceptRepairRequest / useCreateEngineerResponse /
// useEngineerRepairRequestDetail / useEngineerRepairRequestDetailFlow /
// useEngineerRepairRequestList / useEngineerRepairWorkbench）与
// 工程师读写类型均为 feature 内部组成块，由编排 hook / UI 组件经相对路径消费，
// 不作为跨模块公开入口：页面通过 Provider 组合工作台，不直接取用工作台读状态。
// 收敛说明（review P2-3）：创建表单的型号 query 与 create command 改由
// useRepairRequestCreateFlow 在 feature 内装配 concrete adapter，故 createRepairRequest、
// fetchEquipmentModels 不再跨层暴露。
export {
  type CustomerRepairRequestDetailState,
  useCustomerRepairRequestDetailFlow,
} from './application/use-customer-repair-request-detail-flow';
export {
  type CustomerRepairRequestListView,
  useCustomerRepairRequestList,
} from './application/use-customer-repair-request-list';
export {
  type EngineerWorkOrderOption,
  useEngineerWorkOrderOptions,
} from './application/use-engineer-work-order-options';
export type { EngineerRepairListScope } from './infrastructure/engineer-repair-request.types';
export type {
  CreateRepairRequestFailureReason,
  CreateRepairRequestInput,
  CreateRepairRequestResult,
  EquipmentModelOption,
  RepairRequestRecord,
} from './infrastructure/repair-request.types';
export { CustomerRepairRequestDetailPanel } from './ui/customer-repair-request-detail-panel';
export { CustomerRepairRequestListPanel } from './ui/customer-repair-request-list-panel';
export { EngineerRepairRequestDetailPanel } from './ui/engineer-repair-request-detail-panel';
export { EngineerRepairRequestList } from './ui/engineer-repair-request-list';
export { ENGINEER_REPAIR_REQUEST_LIST_PATH } from './ui/engineer-repair-request-paths';
export {
  EngineerRepairWorkbench,
  EngineerRepairWorkbenchProvider,
  EngineerWorkbenchHeaderStats,
} from './ui/engineer-repair-workbench';
export { RepairRequestForm } from './ui/repair-request-form';

// ---- 维修申请公共读模型（PR #A 契约；客户切片与工程师切片共用） ----

export type {
  DeleteMyRepairRequestFailureReason,
  DeleteMyRepairRequestResult,
  EngineerResolutionStatus,
  EngineerResponse,
  MyRepairRequestDetailResult,
  RepairRequestDetail,
  RepairRequestEquipmentModel,
  RepairRequestListItem,
  RepairRequestListPage,
  RepairRequestListPagination,
} from './infrastructure/repair-request-read.types';
export { RESOLUTION_STATUS_LABELS } from './infrastructure/repair-request-read.types';

// 数据访问统一出口：T-02 已切换为真实 GraphQL adapter（与 Mock 同名同签名）。
// 客户列表 / 详情的读删 adapter 不再经 barrel 暴露给 page，改由 customer application hook
// 在 feature 内完成 concrete adapter 装配；Mock 实现与隔离函数
// （resetMyRepairRequestMockState）均不进 barrel，仅测试从 mock-adapter 文件直连导入，
// 保持公开 API 面与真实 adapter 一致（review 裁定 C-1）。
