// src/core/local-runtime/policy/record-package-manifest.policy.ts

import { RECORD_PACKAGE_ERROR, SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';

import { collectClaimKeys, isForbiddenClaimKey } from './local-authorization-renewal.policy';

/**
 * 记录包清单契约与结构校验（任务 09 R070／R071，S2.3）。
 *
 * 包是**目录形态**：`manifest.json` + 清单内相对路径引用的原件文件。
 * 选目录而不是压缩档，是因为当前没有任何封包/压缩依赖（实测 0 个），
 * 且 U 盘交换以目录为单位最直接；"包内容检查"逐文件做 SHA-256 与字节数核对。
 *
 * R071 边界：
 * - 检查不写正式业务（只写 record_package_import / record_package_item）；
 * - 损坏、错公司、越权引用、路径穿越一律拒绝；
 * - "检查合格"不等于"导入成功"，两层事实分开记录。
 */

/** 包清单结构版本；与快照 schema_version 同源（DB CHECK 要求非空） */
export const RECORD_PACKAGE_SCHEMA_VERSION = 1;

/** 本任务可出入包的资源类型（≤32 字符，与 `record_package_item.resource_type` 对齐） */
export const RECORD_PACKAGE_RESOURCE_TYPES = {
  REFERENCE_DOCUMENT: 'REFERENCE_DOCUMENT',
  REPAIR_REQUEST: 'REPAIR_REQUEST',
  MAINTENANCE_REPORT: 'MAINTENANCE_REPORT',
} as const;
export type RecordPackageResourceType =
  (typeof RECORD_PACKAGE_RESOURCE_TYPES)[keyof typeof RECORD_PACKAGE_RESOURCE_TYPES];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** 包清单（生成与检查共用同一契约） */
export type RecordPackageManifest = {
  schema_version: number;
  package_id: string;
  organization_id: number;
  /**
   * 来源公司的**稳定业务编码**（`organization.organization_code`）。
   *
   * 加法式可选字段（任务 09 S1-2）：源机的 `organization_id` 是**源机自增主键**，
   * 在目标机上没有意义（同一公司在两台设备上的 id 可以不同）。跨设备搬运时
   * 必须用**公司业务编码**对齐公司；缺失时按旧口径只比数字 id（同机包），
   * 跨机包会因数字 id 不同而被拒绝（不会误判成同公司）。
   */
  organization_code?: string | null;
  installation_id: string;
  generated_at: string;
  items: RecordPackageManifestItem[];
};

export type RecordPackageManifestItem = {
  record_uuid: string;
  resource_type: string;
  version_no: number;
  /** 该条目的结构化快照（原样入包，检查不解释字段） */
  content_snapshot: unknown;
  files: RecordPackageManifestFile[];
  /**
   * 来源账号（原记录作者/责任工程师）——**加法式可选字段**（S3 补丁 P0/P4）。
   *
   * 为什么可选而不升 schema：旧包已在外部设备上流通，升 `schema_version` 会让
   * 旧包全部无法解析，与"旧包兼容"目标相反。缺失时导入侧按
   * "**来源身份不可核验**"拒绝该条（不得把导入人写成原作者）。
   */
  source_account_id?: number | null;
  /**
   * 来源账号的**跨端稳定标识**（`base_user_account.account_uuid`）——加法式可选字段。
   *
   * 这是**不可变**的跨端身份（创建时一次性生成，唯一索引）：源机与目标机各自建号时
   * 该值不同，命中即证明两个账号行是同一条账号事实（数据库克隆/同步场景）。
   */
  source_account_uuid?: string | null;
  /**
   * 来源账号的**可移植账号名**（`base_user_account.login_name`）——加法式可选字段。
   *
   * 账号名是工程师的**工作账号名**，跨设备可携带；但本人可自助改名，
   * 因此它只作为**次级**映射依据（配合公司编码与姓名快照交叉核对）。
   */
  source_account_login_name?: string | null;
  /** 来源账号的姓名快照（仅供跨设备人工复核，不作唯一判据） */
  source_account_name?: string | null;
  /** 来源归属公司（数据为准，导入侧逐条复核） */
  owner_organization_id?: number | null;
  /**
   * 关联记录的**跨端稳定编号**（如工单总结关联的工单 `repair_request.record_uuid`）。
   *
   * 加法式可选字段：工单总结类报告在目标机上必须能定位到"那一张工单"，
   * 源机的数字外键跨机无意义（按数字 id 猜会把报告挂到另一张工单上）。
   */
  related_record_uuid?: string | null;
  /** 关联记录的资源类型（如 `REPAIR_REQUEST`） */
  related_record_type?: string | null;
  /**
   * 来源记录的**设备机型编码**（`equipment_model.model_code`）——加法式可选字段。
   *
   * 机型 id 是**全局型号库**的自增主键，跨设备同样不可移植（与账号 id 同类缺陷）：
   * 直接写入目标机会把报告挂到**另一款机型**上。因此随包携带稳定的机型编码，
   * 目标机按编码在本机定位；定位不到即逐条拒绝（不猜机型、不静默改成空）。
   */
  source_equipment_model_code?: string | null;
  /**
   * 来源业务状态（如报告的 DRAFT/PENDING_REVIEW/APPROVED）。
   *
   * 导入正式事实必须知道来源状态，否则会把"已通过结单"的内容悄悄降级成待审草稿。
   * 缺失时导入侧按"状态不可核验"拒绝该条（不猜状态）。
   */
  source_status?: string | null;
};

export type RecordPackageManifestFile = {
  /** 包内相对路径；禁止绝对路径、`..`、反斜杠与盘符 */
  relative_path: string;
  sha256: string;
  byte_size: number;
};

/** 拒绝结论（逐条检查结果；不入 DB 的展示码） */
export type RecordPackageItemRejection =
  | 'STRUCTURE_INVALID'
  | 'PATH_ESCAPED'
  | 'FILE_MISSING'
  | 'FILE_CHECKSUM_MISMATCH'
  | 'DUPLICATE_RECORD'
  | 'FOREIGN_COMPANY'
  /** 记录级授权不通过（不是本人有权访问的记录；不是"公司不符"） */
  | 'NOT_AUTHORIZED';

/**
 * 解析并校验包清单结构（不含文件系统访问）：
 * - 顶层必须是对象，schema_version 必须为 1；
 * - package_id 必须为 UUID；organization_id 必须为正整数；
 * - items 必须为数组且非空；每条的 record_uuid 为 UUID、version_no>=1、
 *   resource_type 在允许清单内、files 为数组；
 * - 文件相对路径必须安全（防穿越、防绝对路径、防反斜杠与盘符）；
 * - sha256 形态与 byte_size 非负在结构层校验，内容一致性由检查执行层核对。
 */
export function parseRecordPackageManifest(raw: string): RecordPackageManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_MANIFEST, '包清单不是合法 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_MANIFEST, '包清单必须是对象');
  }
  const manifest = parsed as Record<string, unknown>;

  if (manifest.schema_version !== RECORD_PACKAGE_SCHEMA_VERSION) {
    throw new DomainError(
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
      `包清单 schema_version 必须为 ${RECORD_PACKAGE_SCHEMA_VERSION}`,
    );
  }
  if (typeof manifest.package_id !== 'string' || !UUID_PATTERN.test(manifest.package_id)) {
    throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_MANIFEST, 'package_id 必须为 UUID');
  }
  if (!Number.isInteger(manifest.organization_id) || (manifest.organization_id as number) <= 0) {
    throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_MANIFEST, 'organization_id 必须为正整数');
  }
  if (
    manifest.organization_code !== undefined &&
    manifest.organization_code !== null &&
    (typeof manifest.organization_code !== 'string' ||
      manifest.organization_code.length === 0 ||
      manifest.organization_code.length > 64)
  ) {
    throw new DomainError(
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
      'organization_code 必须为 1~64 字的字符串',
    );
  }
  if (typeof manifest.installation_id !== 'string' || manifest.installation_id === '') {
    throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_MANIFEST, 'installation_id 缺失');
  }
  if (!Array.isArray(manifest.items) || manifest.items.length === 0) {
    throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_MANIFEST, '包清单必须包含至少一条记录');
  }

  const items = manifest.items.map((item, index) => validateManifestItem(item, index));
  return {
    schema_version: RECORD_PACKAGE_SCHEMA_VERSION,
    package_id: manifest.package_id,
    organization_id: manifest.organization_id as number,
    organization_code:
      typeof manifest.organization_code === 'string' ? manifest.organization_code : null,
    installation_id: manifest.installation_id,
    generated_at: typeof manifest.generated_at === 'string' ? manifest.generated_at : '',
    items,
  };
}

function validateManifestItem(item: unknown, index: number): RecordPackageManifestItem {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new DomainError(
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
      `第 ${index + 1} 条记录必须是对象`,
    );
  }
  const record = item as Record<string, unknown>;
  if (typeof record.record_uuid !== 'string' || !UUID_PATTERN.test(record.record_uuid)) {
    throw new DomainError(
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
      `第 ${index + 1} 条 record_uuid 必须为 UUID`,
    );
  }
  if (
    typeof record.resource_type !== 'string' ||
    !Object.values(RECORD_PACKAGE_RESOURCE_TYPES).includes(
      record.resource_type as RecordPackageResourceType,
    )
  ) {
    throw new DomainError(
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
      `第 ${index + 1} 条 resource_type 不在允许清单内`,
    );
  }
  if (!Number.isInteger(record.version_no) || (record.version_no as number) < 1) {
    throw new DomainError(
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
      `第 ${index + 1} 条 version_no 必须为不小于 1 的整数`,
    );
  }
  if (!Array.isArray(record.files)) {
    throw new DomainError(
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
      `第 ${index + 1} 条 files 必须为数组`,
    );
  }
  const files = record.files.map((file) => validateManifestFile(file, index));
  return {
    record_uuid: record.record_uuid,
    resource_type: record.resource_type,
    version_no: record.version_no as number,
    content_snapshot: record.content_snapshot ?? null,
    files,
    source_account_id: readOptionalPositiveInteger(
      record.source_account_id,
      'source_account_id',
      index,
    ),
    source_account_uuid: readOptionalUuid(record.source_account_uuid, 'source_account_uuid', index),
    source_account_login_name: readOptionalText(
      record.source_account_login_name,
      'source_account_login_name',
      index,
      30,
    ),
    source_account_name: readOptionalText(
      record.source_account_name,
      'source_account_name',
      index,
      200,
    ),
    owner_organization_id: readOptionalPositiveInteger(
      record.owner_organization_id,
      'owner_organization_id',
      index,
    ),
    related_record_uuid: readOptionalUuid(record.related_record_uuid, 'related_record_uuid', index),
    related_record_type: readOptionalText(
      record.related_record_type,
      'related_record_type',
      index,
      32,
    ),
    source_equipment_model_code: readOptionalText(
      record.source_equipment_model_code,
      'source_equipment_model_code',
      index,
      50,
    ),
    source_status: readOptionalStatus(record.source_status, index),
  };
}

/** 读取可选 UUID 字段（缺失／为 null 视为"未携带"；形态非法即清单非法） */
function readOptionalUuid(value: unknown, field: string, index: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new DomainError(
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
      `第 ${index + 1} 条 ${field} 必须为 UUID`,
    );
  }
  return value;
}

/** 读取可选文本字段（缺失／为 null 视为"未携带"；空串或超长即清单非法） */
function readOptionalText(
  value: unknown,
  field: string,
  index: number,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new DomainError(
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
      `第 ${index + 1} 条 ${field} 必须为 1~${maxLength} 字的字符串`,
    );
  }
  return value;
}

/** 读取可选状态字符串（缺失／为 null 视为"未携带"；过长即清单非法） */
function readOptionalStatus(value: unknown, index: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 32) {
    throw new DomainError(
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
      `第 ${index + 1} 条 source_status 必须为 1~32 字的字符串`,
    );
  }
  return value;
}

/** 读取可选正整数字段（缺失／为 null 视为"未携带"；类型非法即清单非法） */
function readOptionalPositiveInteger(value: unknown, field: string, index: number): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new DomainError(
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
      `第 ${index + 1} 条 ${field} 必须为正整数`,
    );
  }
  return value as number;
}

function validateManifestFile(file: unknown, index: number): RecordPackageManifestFile {
  if (file === null || typeof file !== 'object' || Array.isArray(file)) {
    throw new DomainError(
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
      `第 ${index + 1} 条存在非法文件描述`,
    );
  }
  const entry = file as Record<string, unknown>;
  if (typeof entry.relative_path !== 'string' || !isSafePackageRelativePath(entry.relative_path)) {
    throw new DomainError(
      RECORD_PACKAGE_ERROR.PATH_ESCAPED,
      `第 ${index + 1} 条存在不安全的文件路径`,
    );
  }
  if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) {
    throw new DomainError(
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
      `第 ${index + 1} 条文件 sha256 形态非法`,
    );
  }
  if (!Number.isInteger(entry.byte_size) || (entry.byte_size as number) < 0) {
    throw new DomainError(
      RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
      `第 ${index + 1} 条文件 byte_size 非法`,
    );
  }
  return {
    relative_path: entry.relative_path,
    sha256: entry.sha256,
    byte_size: entry.byte_size as number,
  };
}

/**
 * 包内相对路径安全规则：
 * - 非空、不以 `/` 开头（禁绝对路径）、不含 `\` 与盘符（Windows 形态）；
 * - 按 `/` 分段后不得出现 `..` 与空段；
 * - 段内不得出现 `.` 以外的保留名（这里只挡 `..`，`./a` 因空段规则已拒绝）。
 */
export function isSafePackageRelativePath(value: string): boolean {
  if (value === '' || value.startsWith('/') || value.includes('\\')) {
    return false;
  }
  if (/^[a-zA-Z]:/.test(value)) {
    return false;
  }
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '..' && segment !== '.');
}

/** 把相对路径解析为包内绝对路径；任何逃逸立即拒绝（双保险，配合 isSafePackageRelativePath） */
export function resolvePackageFilePath(packageRoot: string, relativePath: string): string {
  if (!isSafePackageRelativePath(relativePath)) {
    throw new DomainError(RECORD_PACKAGE_ERROR.PATH_ESCAPED, '文件路径逃逸出包目录');
  }
  const resolved = nodePath.resolve(packageRoot, relativePath);
  const root = nodePath.resolve(packageRoot);
  if (resolved !== root && !resolved.startsWith(root + nodePath.sep)) {
    throw new DomainError(RECORD_PACKAGE_ERROR.PATH_ESCAPED, '文件路径逃逸出包目录');
  }
  return resolved;
}

/**
 * 查看者范围与包公司的一致性（R071"只能检查本公司有权包"）：
 * - 一级管理员（organizationId=null）为全局范围，允许检查任意公司包；
 * - 工程师与二级管理员必须与包公司一致，否则拒绝（错公司）。
 */
export function assertPackageCompanyAllowed(
  viewerOrganizationId: number | null,
  manifestOrganizationId: number,
): void {
  assertOrganizationScopeAllowed(
    viewerOrganizationId,
    manifestOrganizationId,
    '记录包属于其他公司，拒绝检查',
  );
}

/**
 * 公司归属断言（**唯一实现**）：查看方公司非空时，必须与目标公司一致。
 *
 * 此前导出侧（`assertExportOrganizationAllowed`）与导入侧（`assertPackageCompanyAllowed`）
 * 各写了一份逐字相同的判断；这里给出唯一一份，两侧只传各自的文案。
 */
export function assertOrganizationScopeAllowed(
  viewerOrganizationId: number | null,
  targetOrganizationId: number,
  message: string,
): void {
  if (viewerOrganizationId !== null && viewerOrganizationId !== targetOrganizationId) {
    throw new DomainError(RECORD_PACKAGE_ERROR.FOREIGN_COMPANY, message);
  }
}

/**
 * 跨安装可用的公司身份断言（任务 09 S1-2）。
 *
 * 源机与目标机的 `organization.id` 是各自的自增主键，**同一公司在两台设备上
 * 可以是不同的数字 id**。因此跨设备搬运必须用**公司业务编码**
 * （`organization.organization_code`，名称可改、编号不变）来对齐公司。
 *
 * 判定顺序：
 * 1. 查看方为一级管理员（`viewerOrganizationId = null`）→ 全局授权范围，放行；
 * 2. 包清单**携带**公司编码 → 必须与查看方公司的编码一致，否则拒绝
 *    （此时**不再**比较数字 id：跨机时数字 id 本就不同）；
 * 3. 包清单**未携带**公司编码（旧包）→ 回退到数字 id 比较（同机包口径）。
 */
export function assertPackageCompanyAllowedByIdentity(input: {
  viewerOrganizationId: number | null;
  viewerOrganizationCode: string | null;
  manifestOrganizationId: number;
  manifestOrganizationCode: string | null;
}): void {
  if (input.viewerOrganizationId === null) {
    return;
  }
  if (input.manifestOrganizationCode !== null) {
    if (
      input.viewerOrganizationCode !== null &&
      input.viewerOrganizationCode === input.manifestOrganizationCode
    ) {
      return;
    }
    throw new DomainError(RECORD_PACKAGE_ERROR.FOREIGN_COMPANY, '记录包属于其他公司，拒绝检查');
  }
  assertOrganizationScopeAllowed(
    input.viewerOrganizationId,
    input.manifestOrganizationId,
    '记录包属于其他公司，拒绝检查',
  );
}

/**
 * 清单校验值（SHA-256 of 清单原文）——**唯一实现**。
 *
 * 此前导出服务与导入服务各写了一遍 `createHash('sha256').update(raw, 'utf8')`；
 * 与备份包侧的 `backupManifestChecksum` 口径对称：算的都是"清单原文的摘要"。
 */
export function recordPackageManifestChecksum(manifestRaw: string): string {
  return createHash('sha256').update(manifestRaw, 'utf8').digest('hex');
}

/**
 * 续期类校验共用：包内不得出现敏感材料键（R067 同口径）。
 * 这里复用授权续期的键规则，避免两份清单漂移。
 */
export function assertManifestSnapshotHasNoSecretMaterial(snapshot: unknown): void {
  const hit = collectClaimKeys(snapshot).find((key) => isForbiddenClaimKey(key));
  if (hit !== undefined) {
    throw new DomainError(
      SYNC_ERROR.CLAIMS_FORBIDDEN_MATERIAL,
      `包内容包含禁止写入包与日志的敏感材料：${hit}`,
    );
  }
}
