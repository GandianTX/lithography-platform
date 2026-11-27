// src/features/record-package/infrastructure/record-package.types.ts

/** 记录包资源类型（与后端清单契约一致） */
export type RecordPackageResourceType =
  | 'REFERENCE_DOCUMENT'
  | 'REPAIR_REQUEST'
  | 'MAINTENANCE_REPORT';

/**
 * 导出条目（**混合导出**）：逐条自带资源类型。
 *
 * 一次导出可以同时包含工单、报告与资料；服务端逐条复核归属、版本与权限，
 * 单条失败不拖垮整包。
 */
export type RecordPackageExportEntry = {
  resourceType: RecordPackageResourceType;
  recordId: number;
};

/** 逐条导出结论 */
export type RecordPackageExportItem = {
  recordId: number;
  recordUuid: string | null;
  resourceType: string;
  versionNo: number | null;
  outcome: 'EXPORTED' | 'REJECTED';
  rejection: string | null;
  message: string | null;
};

/** 导出结果 */
export type RecordPackageExportResult = {
  packageId: string;
  packagePath: string;
  organizationId: number;
  resourceType: string;
  manifestChecksum: string;
  itemTotal: number;
  itemExported: number;
  itemFailed: number;
  items: RecordPackageExportItem[];
};

/** 逐条检查／导入事实 */
export type RecordPackageItem = {
  itemId: string;
  packageId: string;
  recordUuid: string;
  resourceType: string;
  versionNo: number;
  /** NULL / PASSED / REJECTED */
  checkResult: string | null;
  /** NULL / SUCCEEDED / FAILED / SKIPPED / CONFLICT */
  result: string | null;
  receiptId: string | null;
  errorMessage: string | null;
  createdAt: string;
};

/** 批次事实 */
export type RecordPackageImport = {
  packageId: string;
  organizationId: number;
  importedByAccountId: number;
  manifestChecksum: string;
  /** PENDING / RUNNING / SUCCEEDED / PARTIAL / FAILED */
  status: string;
  /** NULL / PENDING / PASSED / REJECTED */
  checkStatus: string | null;
  itemTotal: number;
  itemSucceeded: number;
  itemFailed: number;
  createdAt: string;
  completedAt: string | null;
};

/** 检查结果 */
export type RecordPackageCheckResult = {
  outcome: 'existing' | 'checked';
  import: RecordPackageImport;
  items: RecordPackageItem[];
};

/** 处理结果（检查结论与导入结果同结构） */
export type RecordPackageProcessResult = {
  import: RecordPackageImport;
  items: RecordPackageItem[];
};
