// src/modules/lithography/record-package-import.types.ts

import type { RecordPackageItemRejection } from '@core/local-runtime/policy/record-package-manifest.policy';

/**
 * 记录包检查/导入读模型契约（任务 09 R071–R073）。
 *
 * `record_package_import` 主键即 package_id：同包重复检查返回既有事实，
 * 不产生第二个批次（"同包重复操作一个事实"）。
 */
export type RecordPackageImportSnapshot = {
  packageId: string;
  organizationId: number;
  importedByAccountId: number;
  manifestJson: string;
  manifestChecksum: string;
  /** PENDING / RUNNING / SUCCEEDED / PARTIAL / FAILED */
  status: string;
  /** NULL / PENDING / PASSED / REJECTED */
  checkStatus: string | null;
  itemTotal: number;
  itemSucceeded: number;
  itemFailed: number;
  createdAt: Date;
  completedAt: Date | null;
};

export type RecordPackageItemSnapshot = {
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
  createdAt: Date;
};

/** 单条检查结论（检查执行层的逐条事实） */
export type RecordPackageItemCheckOutcome = {
  recordUuid: string;
  resourceType: string;
  versionNo: number;
  passed: boolean;
  /** 拒绝码：结构非法/路径逃逸/缺文件/校验不符/重复记录/错公司 */
  rejection: RecordPackageItemRejection | null;
  message: string | null;
};

export type RecordPackageCheckCommand = {
  /** 包目录（U盘挂载点或本机目录），内含 manifest.json 与清单引用文件 */
  packagePath: string;
  /** 查看者的可信公司数据区（一级管理员为 null＝全局授权范围） */
  organizationId: number | null;
  /**
   * 查看者公司的**稳定业务编码**（`organization.organization_code`）。
   *
   * 跨设备搬运时源机的 `organization_id` 在目标机无意义（同一公司在两台设备上
   * 可以是不同数字 id），因此跨机对齐公司必须用业务编码（任务 09 S1-2）。
   */
  organizationCode: string | null;
  importedByAccountId: number;
};

export type RecordPackageCheckResult = {
  /** 'existing'：同包重复检查返回既有事实，不产生第二个批次 */
  outcome: 'checked' | 'existing';
  import: RecordPackageImportSnapshot;
  items: RecordPackageItemSnapshot[];
};
