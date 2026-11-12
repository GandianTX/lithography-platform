// scripts/mock-v13/files.ts

/**
 * Mock 原件的真实文件与记录包样例。
 *
 * 只写入 `--mock-file-dir` / `--reference-storage-dir` 指定目录；文件内容由稳定键派生，
 * 重跑时内容一致即复用，不一致视为异主文件并拒绝覆盖。事务失败时只删除本次新建的文件。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { MockConflictError } from './errors';
import { MOCK_LABEL, MOCK_PREFIX } from './manifest';

export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** 键排序后的稳定 JSON，用于校验和与快照。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 1x1 PNG，真实可读的图片原件。 */
export function mockPng(): Buffer {
  return Buffer.from(PNG_BASE64, 'base64');
}

/** 真实可读的文本原件（避免伪造 PDF 结构）。 */
export function mockTextDocument(title: string, body: string): Buffer {
  return Buffer.from(
    [`${MOCK_LABEL} ${title}`, '', body, '', '本文件为 V13 开发 Mock 数据，仅用于开发联调。'].join(
      '\n',
    ),
    'utf8',
  );
}

export function mockBackupManifest(runKey: string): Buffer {
  return Buffer.from(
    canonicalJson({
      schema_version: 1,
      mock: true,
      source: MOCK_PREFIX,
      run: runKey,
      note: '未接入隔离备份执行器；本清单仅用于状态与非成功样例。',
      files: [],
    }),
    'utf8',
  );
}

export interface MockPackageItem {
  readonly record_uuid: string;
  readonly resource_type: string;
  readonly version_no: number;
  readonly payload: Record<string, unknown>;
}

export interface MockPackage {
  readonly schema_version: 1;
  readonly mock: true;
  readonly package_id: string;
  readonly organization_code: string;
  readonly generated_at: string;
  readonly items: readonly MockPackageItem[];
  readonly payload_sha256: string;
}

export function buildMockPackage(input: {
  readonly packageId: string;
  readonly organizationCode: string;
  readonly generatedAt: string;
  readonly items: readonly MockPackageItem[];
}): MockPackage {
  return {
    schema_version: 1,
    mock: true,
    package_id: input.packageId,
    organization_code: input.organizationCode,
    generated_at: input.generatedAt,
    items: input.items,
    payload_sha256: sha256Hex(canonicalJson(input.items)),
  };
}

/** 故意保留旧校验和，用于“损坏包”对照。 */
export function corruptMockPackage(valid: MockPackage): MockPackage {
  const tampered = valid.items.map((item) => ({
    ...item,
    payload: { ...item.payload, tampered: true },
  }));
  return { ...valid, items: tampered };
}

export interface PackageVerification {
  readonly ok: boolean;
  readonly expected: string;
  readonly computed: string;
}

export function verifyMockPackageContent(content: string): PackageVerification {
  const parsed = JSON.parse(content) as Partial<MockPackage>;
  if (!Array.isArray(parsed.items) || typeof parsed.payload_sha256 !== 'string') {
    throw new MockConflictError('记录包缺少 items 或 payload_sha256，无法校验');
  }
  const computed = sha256Hex(canonicalJson(parsed.items));
  return { ok: computed === parsed.payload_sha256, expected: parsed.payload_sha256, computed };
}

/** 文件登记器：只删除本次运行创建的文件。 */
export class FileRegistry {
  private readonly created: string[] = [];
  private readonly allowedRoots: readonly string[];

  constructor(allowedRoots: readonly string[]) {
    this.allowedRoots = allowedRoots.map((root) => path.resolve(root));
  }

  private assertInsideAllowedRoots(absolutePath: string): void {
    const inside = this.allowedRoots.some(
      (root) => absolutePath === root || absolutePath.startsWith(`${root}${path.sep}`),
    );
    if (!inside) {
      throw new MockConflictError(`拒绝在受控目录之外写文件: ${absolutePath}`);
    }
  }

  /** 内容一致则复用；不存在则创建；内容不一致视为异主文件。 */
  ensure(absolutePath: string, content: Buffer): 'CREATED' | 'REUSED' {
    const absolute = path.resolve(absolutePath);
    this.assertInsideAllowedRoots(absolute);
    if (fs.existsSync(absolute)) {
      const existing = fs.readFileSync(absolute);
      if (sha256Hex(existing) !== sha256Hex(content)) {
        throw new MockConflictError(`文件已存在但内容不同，拒绝覆盖: ${absolute}`);
      }
      return 'REUSED';
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, { flag: 'wx', mode: 0o640 });
    this.created.push(absolute);
    return 'CREATED';
  }

  /** 回滚时仅回收本次创建的文件。 */
  cleanupCreated(): void {
    for (const file of this.created.splice(0)) {
      try {
        fs.unlinkSync(file);
      } catch {
        // 文件可能已被人工处理，回收失败不掩盖原始错误。
      }
    }
  }

  createdCount(): number {
    return this.created.length;
  }
}

export interface CredentialIndexEntry {
  readonly loginName: string;
  readonly email: string;
  readonly role: string;
  readonly adminLevel: number | null;
  readonly organization: string;
  readonly state: string;
  readonly scenario: string;
}

export interface CredentialFileContent {
  readonly generated_at: string;
  readonly mock: true;
  readonly warning: string;
  readonly password: string;
  readonly accounts: readonly CredentialIndexEntry[];
}

/**
 * 受控凭据文件：0600，且使用 `wx` 避免覆盖既有交付件。
 * 返回值表示是否新写入；已存在时不覆盖（重跑不改变凭据）。
 */
export function writeCredentialsFile(filePath: string, content: CredentialFileContent): boolean {
  const serialized = `${JSON.stringify(content, null, 2)}\n`;
  try {
    fs.writeFileSync(filePath, serialized, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}
