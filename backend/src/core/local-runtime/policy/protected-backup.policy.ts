// src/core/local-runtime/policy/protected-backup.policy.ts
// 受保护备份包契约（任务 09 S3.1）：包清单结构、范围快照一致性、AES-256-GCM 载荷保护与落盘前自校验。

import { DomainError, LOCAL_RUNTIME_ERROR } from '@core/common/errors/domain-error';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

/** 备份包清单结构版本（与记录包 RECORD_PACKAGE_SCHEMA_VERSION 相互独立） */
export const BACKUP_MANIFEST_SCHEMA_VERSION = 1;

/** 纳入备份一致性快照的表（按公司圈定的恢复影响范围；逐表计数＋最新更新时间） */
export const BACKUP_SCOPE_TABLES = [
  'repair_request',
  'maintenance_report',
  'reference_document',
  'stored_file',
  'local_upload_task',
  'local_backup_run',
] as const;

export type BackupScopeTable = (typeof BACKUP_SCOPE_TABLES)[number];

export type BackupScopeEntry = {
  table: BackupScopeTable;
  rowCount: number;
  /** 该表公司数据区最新更新时间（ISO 8601）；空表为 null */
  lastUpdatedAt: string | null;
};

/** 包内文件事实（payload.enc 或 files/…），路径禁绝对与穿越成分 */
export type BackupManifestFile = {
  relative_path: string;
  sha256: string;
  byte_size: number;
};

/** 原件引用事实：来源存储引用＋登记校验值（未复制物理文件时仍可追溯来源） */
export type BackupManifestOriginal = {
  source: string;
  storage_reference: string;
  sha256: string | null;
};

export type BackupManifest = {
  schema_version: number;
  /** 备份包 ID（backup_asset.backup_id） */
  backup_id: string;
  organization_id: number;
  installation_id: string;
  /** 产生本次备份的运行 ID */
  run_id: number | null;
  generated_at: string;
  encryption: {
    algorithm: 'AES-256-GCM';
    /** 保护密钥标识（backup_asset.encryption_key_id 同源），密钥本身不落包 */
    key_id: string;
    /** 12 字节 IV（hex） */
    iv: string;
    /** 16 字节 GCM auth tag（hex） */
    auth_tag: string;
  };
  /** 一致性范围快照（逐表计数＋最新更新时间） */
  scope: BackupScopeEntry[];
  /** 包内文件清单（payload.enc 与已复制原件） */
  files: BackupManifestFile[];
  /** 原件引用清单（公司数据区业务原件，物理复制随备份范围增量） */
  originals: BackupManifestOriginal[];
};

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX_24 = /^[0-9a-f]{24}$/;
const HEX_32 = /^[0-9a-f]{32}$/;

function invalid(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError(LOCAL_RUNTIME_ERROR.BACKUP_FAILED, message, details);
}

/** 保护密钥解析：必须为 64 位十六进制（AES-256 需要 32 字节），不回显内容 */
export function parseProtectionKey(rawKey: string | null | undefined): Buffer {
  const raw = (rawKey ?? '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw invalid('保护密钥必须为 64 位十六进制（AES-256 密钥）');
  }
  return Buffer.from(raw, 'hex');
}

/** 生成新的包 ID（backup_asset.backup_id / manifest.backup_id 同源） */
export function generateBackupId(): string {
  return randomUUID();
}

/** AES-256-GCM 加密数据载荷：随机 IV，返回 { data, iv, authTag }（hex） */
export function encryptBackupPayload(
  key: Buffer,
  plaintext: Buffer,
): { data: Buffer; iv: string; authTag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { data, iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex') };
}

/** AES-256-GCM 解密数据载荷（auth tag 不符即失败关闭） */
export function decryptBackupPayload(
  key: Buffer,
  data: Buffer,
  ivHex: string,
  authTagHex: string,
): Buffer {
  if (!HEX_24.test(ivHex) || !HEX_32.test(authTagHex)) {
    throw invalid('加密元数据（IV／auth tag）形态非法');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw invalid('备份载荷解密失败（密钥不符或数据被篡改）');
  }
}

/** 包内相对路径安全：禁绝对路径、穿越成分与反斜杠 */
export function isSafeBackupRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || value.includes('\\')) {
    return false;
  }
  if (value.includes('..')) {
    return false;
  }
  return true;
}

function streamSha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * 组装备份清单并做落盘前自校验：产物必须能通过 parseBackupManifest。
 * 任何字段非法都在写盘前失败（不存在"半个合法包"）。
 */
export function buildProtectedBackupManifest(input: {
  organizationId: number;
  installationId: string;
  runId: number | null;
  generatedAt: Date;
  encryption: { keyId: string; iv: string; authTag: string };
  scope: BackupScopeEntry[];
  files: BackupManifestFile[];
  originals: BackupManifestOriginal[];
  backupId?: string;
}): BackupManifest {
  const backupId = input.backupId ?? generateBackupId();
  const manifest: BackupManifest = {
    schema_version: BACKUP_MANIFEST_SCHEMA_VERSION,
    backup_id: backupId,
    organization_id: input.organizationId,
    installation_id: input.installationId,
    run_id: input.runId,
    generated_at: input.generatedAt.toISOString(),
    encryption: {
      algorithm: 'AES-256-GCM',
      key_id: input.encryption.keyId,
      iv: input.encryption.iv,
      auth_tag: input.encryption.authTag,
    },
    scope: input.scope,
    files: input.files,
    originals: input.originals,
  };
  parseBackupManifest(manifest);
  return manifest;
}

/**
 * 备份包清单结构校验（生成自校验与 S4 恢复预检共用同一契约）。
 * 校验失败抛 LOCAL_RUNTIME_ERROR.BACKUP_FAILED。
 */
export function parseBackupManifest(value: unknown): BackupManifest {
  const manifest = value as BackupManifest | null;
  if (manifest === null || typeof manifest !== 'object') {
    throw invalid('备份清单必须是 JSON 对象');
  }
  if (manifest.schema_version !== BACKUP_MANIFEST_SCHEMA_VERSION) {
    throw invalid('备份清单结构版本不符', { schema_version: manifest.schema_version });
  }
  if (typeof manifest.backup_id !== 'string' || !UUID_V4.test(manifest.backup_id)) {
    throw invalid('备份包 ID 非法', { backup_id: manifest.backup_id });
  }
  if (!Number.isInteger(manifest.organization_id) || manifest.organization_id <= 0) {
    throw invalid('备份公司 ID 非法');
  }
  if (typeof manifest.installation_id !== 'string' || manifest.installation_id.length === 0) {
    throw invalid('安装标识缺失');
  }
  if (manifest.run_id !== null && !Number.isInteger(manifest.run_id)) {
    throw invalid('备份运行 ID 非法');
  }
  if (typeof manifest.generated_at !== 'string' || !ISO_8601.test(manifest.generated_at)) {
    throw invalid('生成时间必须为 ISO 8601');
  }

  const encryption = manifest.encryption;
  if (
    encryption === null ||
    typeof encryption !== 'object' ||
    encryption.algorithm !== 'AES-256-GCM' ||
    typeof encryption.key_id !== 'string' ||
    encryption.key_id.length === 0 ||
    !HEX_24.test(encryption.iv ?? '') ||
    !HEX_32.test(encryption.auth_tag ?? '')
  ) {
    throw invalid('备份保护元数据非法');
  }

  if (!Array.isArray(manifest.scope) || manifest.scope.length !== BACKUP_SCOPE_TABLES.length) {
    throw invalid('一致性范围快照必须覆盖全部范围表');
  }
  const seenTables = new Set<string>();
  for (const entry of manifest.scope) {
    if (!BACKUP_SCOPE_TABLES.includes(entry?.table)) {
      throw invalid('范围快照包含未知表', { table: entry?.table });
    }
    if (seenTables.has(entry.table)) {
      throw invalid('范围快照表重复', { table: entry.table });
    }
    seenTables.add(entry.table);
    if (!Number.isInteger(entry.rowCount) || entry.rowCount < 0) {
      throw invalid('范围快照行数非法', { table: entry.table });
    }
    if (entry.lastUpdatedAt !== null && !ISO_8601.test(entry.lastUpdatedAt)) {
      throw invalid('范围快照更新时间必须为 ISO 8601 或 null', { table: entry.table });
    }
  }

  if (!Array.isArray(manifest.files)) {
    throw invalid('备份文件清单缺失');
  }
  for (const file of manifest.files) {
    if (!isSafeBackupRelativePath(file?.relative_path ?? '')) {
      throw invalid('备份文件路径不安全', { path: file?.relative_path });
    }
    if (!SHA256_HEX.test(file?.sha256 ?? '')) {
      throw invalid('备份文件校验值非法', { path: file?.relative_path });
    }
    if (!Number.isInteger(file?.byte_size) || file.byte_size < 0) {
      throw invalid('备份文件字节数非法', { path: file?.relative_path });
    }
  }

  if (!Array.isArray(manifest.originals)) {
    throw invalid('原件引用清单缺失');
  }
  for (const original of manifest.originals) {
    if (
      typeof original?.source !== 'string' ||
      original.source.length === 0 ||
      typeof original.storage_reference !== 'string' ||
      original.storage_reference.length === 0
    ) {
      throw invalid('原件引用非法');
    }
    if (original.sha256 !== null && !SHA256_HEX.test(original.sha256 ?? '')) {
      throw invalid('原件登记校验值非法', { source: original.source });
    }
  }

  return manifest;
}

/** 清单校验值（backup_asset.manifest_checksum / local_backup_run.manifest_checksum 同源） */
export function backupManifestChecksum(manifestRaw: string): string {
  return streamSha256Hex(manifestRaw);
}

/** 数据载荷默认相对路径 */
export const BACKUP_PAYLOAD_PATH = 'payload.enc';
