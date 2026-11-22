// src/features/record-package/infrastructure/record-package-adapter.ts

import { executeGraphQL } from '@/shared/graphql';

import type {
  RecordPackageCheckResult,
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
    $organizationId: Int!
    $resourceType: RecordPackageResourceType!
    $recordIds: [Int!]!
  ) {
    exportRecordPackage(
      targetPath: $targetPath
      organizationId: $organizationId
      resourceType: $resourceType
      recordIds: $recordIds
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

/** 导出记录包到本机目录（U盘挂载点） */
export async function exportRecordPackage(input: {
  targetPath: string;
  organizationId: number;
  resourceType: RecordPackageResourceType;
  recordIds: number[];
}): Promise<RecordPackageExportResult> {
  const data = await executeGraphQL<
    { exportRecordPackage: RecordPackageExportResult },
    {
      targetPath: string;
      organizationId: number;
      resourceType: RecordPackageResourceType;
      recordIds: number[];
    }
  >(EXPORT_RECORD_PACKAGE, input);

  return data.exportRecordPackage;
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
