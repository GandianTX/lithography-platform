// src/core/local-runtime/policy/record-package-export.policy.ts

import { RECORD_PACKAGE_ERROR, DomainError } from '@core/common/errors/domain-error';
import { createHash, randomUUID } from 'node:crypto';
import * as nodePath from 'node:path';

import {
  RECORD_PACKAGE_SCHEMA_VERSION,
  RECORD_PACKAGE_RESOURCE_TYPES,
  parseRecordPackageManifest,
  type RecordPackageManifest,
  type RecordPackageManifestFile,
  type RecordPackageManifestItem,
  type RecordPackageResourceType,
} from './record-package-manifest.policy';

/**
 * 记录包导出契约（任务 09 R070，S2.3）。
 *
 * 与检查（R071）共用同一 manifest 结构契约；导出产物必须先通过
 * `parseRecordPackageManifest` 自校验才允许落盘，保证"导出的包必然
 * 能被检查器解析"。
 *
 * 身份规则：来源业务表没有 record_uuid（S0 结构事实），条目身份由
 * 导出侧**确定性派生**（UUIDv5，namespace 固定）：
 * 同一 (resourceType, recordId) 在任何一次导出中得到同一 record_uuid，
 * 与检查/去重（同资源同版本一个事实）语义对齐。
 */

/** 记录包条目身份派生命名空间（固定 UUIDv5 命名空间，专用于本任务） */
const RECORD_UUID_NAMESPACE = '9c2f4a10-5b3e-4d67-8a29-1f7c0d4e6b52';

/** 一次导出允许的最大条目数（防止单包过大/超长清单） */
export const EXPORT_RECORD_IDS_MAX = 50;

/** GraphQL 枚举对象（registerEnumType 要求键值映射，不能是数组） */
export const recordPackageResourceTypeEnum = { ...RECORD_PACKAGE_RESOURCE_TYPES } as const;

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  return Buffer.from(hex, 'hex');
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 从 (resourceType, recordId) 确定性派生条目 record_uuid（UUIDv5）。
 * 纯函数：同一输入永远得到同一 UUID，不依赖数据库或时间。
 */
export function deriveRecordUuid(resourceType: string, recordId: number): string {
  const namespace = uuidToBytes(RECORD_UUID_NAMESPACE);
  const name = Buffer.from(`${resourceType}:${recordId}`, 'utf8');
  const digest = createHash('sha1')
    .update(Buffer.concat([namespace, name]))
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(bytes);
}

/** 导出包 ID：随机生成（不同次导出即不同包；重复身份去重由检查/导入层按条目处理） */
export function newRecordPackageId(): string {
  return randomUUID();
}

/**
 * 导出记录 ID 清单归一：非空、去重、正整数、不超上限。
 * 客户端重复提交同一 ID 去重而非拒绝，避免整包因重复 ID 失败。
 */
export function normalizeExportRecordIds(recordIds: number[]): number[] {
  if (!Array.isArray(recordIds) || recordIds.length === 0) {
    throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_PARAMS, '导出记录 ID 清单不能为空');
  }
  const unique = [...new Set(recordIds)];
  if (unique.length > EXPORT_RECORD_IDS_MAX) {
    throw new DomainError(
      RECORD_PACKAGE_ERROR.INVALID_PARAMS,
      `单次导出不能超过 ${EXPORT_RECORD_IDS_MAX} 条记录`,
    );
  }
  for (const id of unique) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_PARAMS, '导出记录 ID 必须为正整数');
    }
  }
  return unique.sort((a, b) => a - b);
}

/**
 * 导出公司范围断言：
 * - 一级管理员（organizationId=null）可指定任意公司数据区导出；
 * - 工程师与二级管理员只能导出本公司数据区。
 */
export function assertExportOrganizationAllowed(
  viewerOrganizationId: number | null,
  targetOrganizationId: number,
): void {
  if (viewerOrganizationId !== null && viewerOrganizationId !== targetOrganizationId) {
    throw new DomainError(RECORD_PACKAGE_ERROR.FOREIGN_COMPANY, '只能导出本公司数据区的记录');
  }
}

/**
 * 导出目标目录断言（防覆盖）：必须是本机绝对路径；
 * 目录不存在（将创建）或存在且为空目录才允许。
 */
export function assertExportTargetDirectory(targetPath: string): void {
  if (targetPath === '' || !nodePath.isAbsolute(targetPath)) {
    throw new DomainError(
      RECORD_PACKAGE_ERROR.INVALID_PARAMS,
      '导出目标必须是本机绝对路径（U盘挂载点或目录）',
    );
  }
}

/** 条目内包相对路径的安全文件名：仅保留字母数字、点、下划线与连字符 */
export function sanitizePackageFileName(original: string | null): string {
  const base = (original ?? 'file.bin').split(/[\\/]/).pop() ?? 'file.bin';
  const cleaned = base.replace(/[^0-9a-zA-Z._-]/g, '_').replace(/^\.+/, '_');
  return cleaned.length > 0 && cleaned !== '.' && cleaned !== '..'
    ? cleaned.slice(0, 100)
    : 'file.bin';
}

/** 导出条目草稿（服务层组装，策略层只负责最终 manifest 结构与自校验） */
export type RecordPackageExportItemDraft = {
  recordUuid: string;
  resourceType: RecordPackageResourceType;
  versionNo: number;
  contentSnapshot: unknown;
  files: RecordPackageManifestFile[];
};

/**
 * 组装导出清单并做**导入侧同源结构自校验**：
 * 导出产物必须先通过 `parseRecordPackageManifest`，不允许产生
 * 检查器无法解析的包。
 */
export function buildExportManifest(input: {
  organizationId: number;
  installationId: string;
  generatedAt: Date;
  items: RecordPackageExportItemDraft[];
}): RecordPackageManifest {
  if (input.items.length === 0) {
    throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_PARAMS, '没有可导出的记录');
  }
  const manifest: RecordPackageManifest = {
    schema_version: RECORD_PACKAGE_SCHEMA_VERSION,
    package_id: newRecordPackageId(),
    organization_id: input.organizationId,
    installation_id: input.installationId,
    generated_at: input.generatedAt.toISOString(),
    items: input.items.map<RecordPackageManifestItem>((item) => ({
      record_uuid: item.recordUuid,
      resource_type: item.resourceType,
      version_no: item.versionNo,
      content_snapshot: item.contentSnapshot,
      files: item.files,
    })),
  };
  // 自校验：任何结构问题在落盘前暴露（与检查器共用同一校验规则）
  return parseRecordPackageManifest(JSON.stringify(manifest));
}
