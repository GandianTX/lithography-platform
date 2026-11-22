// src/features/my-records/index.ts
// 切片公开出口：页面只消费列表/详情面板、路径与任务 06 对接点。

export {
  resolveTask06CreateEntry,
  resolveTask06DraftEditorEntry,
  TASK_06_EDITOR_INTEGRATION_STATUS,
} from './application/task-06-editor-entry';
export type {
  MyRecordDetail,
  MyRecordListFilter,
  MyRecordListPage,
  MyRecordRecordKind,
  MyRecordSourceType,
  MyRecordStatus,
  MyRecordSummary,
} from './infrastructure/my-records.types';
export { isDraftRecordStatus } from './infrastructure/my-records.types';
export { MyRecordDetailPanel } from './ui/my-record-detail-panel';
export {
  buildMyRecordDetailPath,
  buildPublishedDocumentPath,
  MY_RECORDS_LIST_PATH,
  parseMyRecordIdParam,
} from './ui/my-record-paths';
export { MyRecordsList } from './ui/my-records-list';
