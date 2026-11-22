// src/features/admin-operation-records/index.ts

// 任务10 关键操作记录 feature 出口：只读表组件、列表 hook 与数据访问 API。
// 本 feature 不依赖其他 feature；范围/授权全部在后端裁决，前端不传任何范围参数。
export type { OperationRecordsState } from './application/use-operation-records-list';
export { useOperationRecordsList } from './application/use-operation-records-list';
export type {
  OperationRecordDetail,
  OperationRecordItem,
  OperationRecordListPage,
  OperationRecordOperation,
  OperationRecordResult,
} from './infrastructure/admin-operation-records.types';
export { OPERATION_RECORD_OPERATIONS } from './infrastructure/admin-operation-records.types';
export { fetchOperationRecords } from './infrastructure/admin-operation-records-adapter';
export { OperationRecordsTable } from './ui/operation-records-table';
