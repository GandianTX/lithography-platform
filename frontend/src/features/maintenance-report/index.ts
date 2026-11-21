// src/features/maintenance-report/index.ts
//
// 维修报告（任务 06）对页面层的稳定出口。内部 model/infrastructure 不跨层暴露。

export {
  MAINTENANCE_RECORDS_PATH,
  type MaintenanceReportEditorMode,
  MaintenanceReportEditorPage,
  WORK_ORDER_SUMMARIES_PATH,
} from './ui/maintenance-report-editor-page';
export { MaintenanceReportList } from './ui/maintenance-report-list';
export { WorkOrderSummaryEntryCard } from './ui/work-order-summary-entry-card';
export { WorkOrderSummaryList } from './ui/work-order-summary-list';
