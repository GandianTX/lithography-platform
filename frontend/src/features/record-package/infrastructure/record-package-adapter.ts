// src/features/record-package/infrastructure/record-package-adapter.ts

import { executeGraphQL } from '@/shared/graphql';

import type {
  RecordPackageCheckResult,
  RecordPackageExportEntry,
  RecordPackageExportResult,
  RecordPackageProcessResult,
  RecordPackageResourceType,
} from './record-package.types';

/**
 * 记录包真实 GraphQL 数据访问层。
 *
 * 权限口径：导出范围、检查与导入都由服务端按 Session 裁决；前端不传公司参数
 * 决定权限（导出目标公司由服务端按会话范围校验）。
 */

const EXPORT_RECORD_PACKAGE = `
  mutation ExportRecordPackage(
    $targetPath: String!
    $organizationId: Int
    $resourceType: RecordPackageResourceType!
    $recordIds: [Int!]!
    $entries: [RecordPackageExportEntryInput!]
  ) {
    exportRecordPackage(
      targetPath: $targetPath
      organizationId: $organizationId
      resourceType: $resourceType
      recordIds: $recordIds
      entries: $entries
    ) {
      packageId
      packagePath
      organizationId
      resourceType
      manifestChecksum
      itemTotal
      itemExported
      itemFailed
      items {
        recordId
        recordUuid
        resourceType
        versionNo
        outcome
        rejection
        message
      }
    }
  }
`;

const CHECK_RECORD_PACKAGE = `
  mutation CheckRecordPackage($packagePath: String!) {
    checkRecordPackage(packagePath: $packagePath) {
      outcome
      import {
        packageId
        organizationId
        importedByAccountId
        manifestChecksum
        status
        checkStatus
        itemTotal
        itemSucceeded
        itemFailed
        createdAt
        completedAt
      }
      items {
        itemId
        packageId
        recordUuid
        resourceType
        versionNo
        checkResult
        result
        receiptId
        errorMessage
        createdAt
      }
    }
  }
`;

const IMPORT_RECORD_PACKAGE = `
  mutation ImportRecordPackage(
    $packageId: String!
    $packagePath: String!
    $manifestChecksum: String!
  ) {
    importRecordPackage(
      packageId: $packageId
      packagePath: $packagePath
      manifestChecksum: $manifestChecksum
    ) {
      import {
        packageId
        organizationId
        importedByAccountId
        manifestChecksum
        status
        checkStatus
        itemTotal
        itemSucceeded
        itemFailed
        createdAt
        completedAt
      }
      items {
        itemId
        packageId
        recordUuid
        resourceType
        versionNo
        checkResult
        result
        receiptId
        errorMessage
        createdAt
      }
    }
  }
`;

/**
 * 导出记录包到本机目录（U盘挂载点）。
 *
 * `entries` 是**混合导出**形态：逐条自带资源类型，一次导出可以同时包含
 * 工单、报告与资料；提供时服务端以它为准（旧的单一类型形态保持可用）。
 */
export async function exportRecordPackage(input: {
  targetPath: string;
  /** 可省略：省略时由服务端按可信 session 范围取本公司（来源页导出入口） */
  organizationId?: number;
  resourceType: RecordPackageResourceType;
  /** 记录 ID：多值输入控件给出的是字符串，这里统一归一化为正整数 */
  recordIds: Array<number | string>;
  entries?: RecordPackageExportEntry[];
}): Promise<RecordPackageExportResult> {
  const data = await executeGraphQL<
    { exportRecordPackage: RecordPackageExportResult },
    {
      targetPath: string;
      organizationId?: number;
      resourceType: RecordPackageResourceType;
      recordIds: number[];
      entries?: RecordPackageExportEntry[] | null;
    }
  >(EXPORT_RECORD_PACKAGE, {
    ...input,
    recordIds: normalizeRecordIds(input.recordIds),
    entries: input.entries ?? null,
  });

  return data.exportRecordPackage;
}

/** 记录 ID 归一化：只保留正整数（GraphQL 变量为 `[Int!]!`，不接受字符串） */
export function normalizeRecordIds(values: Array<number | string>): number[] {
  return values
    .map((value) => (typeof value === 'number' ? value : Number.parseInt(String(value).trim(), 10)))
    .filter((value) => Number.isInteger(value) && value > 0);
}

/** 安全预检：只落检查事实，不写正式业务 */
export async function checkRecordPackage(packagePath: string): Promise<RecordPackageCheckResult> {
  const data = await executeGraphQL<
    { checkRecordPackage: RecordPackageCheckResult },
    { packagePath: string }
  >(CHECK_RECORD_PACKAGE, { packagePath });

  return data.checkRecordPackage;
}

/** 明确确认后导入：受控逐项导入，逐条结果 */
export async function importRecordPackage(input: {
  packageId: string;
  packagePath: string;
  manifestChecksum: string;
}): Promise<RecordPackageProcessResult> {
  const data = await executeGraphQL<
    { importRecordPackage: RecordPackageProcessResult },
    { packageId: string; packagePath: string; manifestChecksum: string }
  >(IMPORT_RECORD_PACKAGE, input);

  return data.importRecordPackage;
}
