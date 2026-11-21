// src/modules/lithography/record-package-export.types.ts

import type {
  RecordPackageItemRejection,
  RecordPackageResourceType,
} from '@core/local-runtime/policy/record-package-manifest.policy';

/**
 * 记录包导出契约（任务 09 R070，S2.3）。
 *
 * 导出是**逐条结果**语义：范围内不存在/归属未知/版本未生效/文件不可读
 * 的条目单独拒绝，不影响其他条目；全部失败时整包不产生。
 * 条目身份（record_uuid）由导出侧确定性派生（见 record-package-export.policy）。
 */

export type RecordPackageExportCommand = {
  organizationId: number;
  /** 导出目标目录（本机绝对路径；必须不存在或为空目录，防覆盖） */
  targetPath: string;
  resourceType: RecordPackageResourceType;
  recordIds: number[];
};

/** 已完成读取与文件登记的导出条目（进入清单） */
export type RecordPackageExportEntry = {
  recordId: number;
  recordUuid: string;
  resourceType: RecordPackageResourceType;
  versionNo: number;
  contentSnapshot: unknown;
  files: RecordPackageExportFileEntry[];
};

/** 包内文件与来源的对应关系（复制时流式核对） */
export type RecordPackageExportFileEntry = {
  relativePath: string;
  /** 来源存储引用（由服务端登记，导出层经只读流读取，不经手绝对路径） */
  storageReference: string;
  /** 登记的校验值（可空：来源未登记时只实测写入清单） */
  expectedSha256: string | null;
  expectedByteSize: number | null;
};

/** 逐条导出结论 */
export type RecordPackageExportItemOutcome = {
  recordId: number;
  recordUuid: string | null;
  resourceType: RecordPackageResourceType;
  versionNo: number | null;
  outcome: 'EXPORTED' | 'REJECTED';
  rejection: RecordPackageItemRejection | null;
  message: string | null;
};

export type RecordPackageExportResult = {
  packageId: string;
  packagePath: string;
  organizationId: number;
  resourceType: RecordPackageResourceType;
  manifestChecksum: string;
  itemTotal: number;
  itemExported: number;
  itemFailed: number;
  items: RecordPackageExportItemOutcome[];
};
