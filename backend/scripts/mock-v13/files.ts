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

import { MockConflictError, MockWriteError } from './errors';
import { assertNoSymlinkComponents } from './guard';
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

/** 本次运行创建的文件记录：dev/ino 用于确认清理对象仍是同一文件。 */
interface CreatedFile {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  /** 创建时的内容哈希：inode 可能被系统复用，需同时核对内容身份。 */
  readonly sha256: string;
}

export interface CleanupResult {
  readonly removed: readonly string[];
  /** 无法确认仍是本轮创建对象而保留的文件（含原因）。 */
  readonly retained: readonly string[];
  readonly errors: readonly string[];
}

function lstatOrNull(targetPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** 文件登记器：只删除本次运行创建、且仍能确认对象身份的文件。 */
export class FileRegistry {
  private readonly created: CreatedFile[] = [];
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

  /** 目录创建后按真实路径再次核对，避免链接把实际落点带出受控根。 */
  private assertRealParentInsideAllowedRoots(absolutePath: string): void {
    const parentRealPath = fs.realpathSync(path.dirname(absolutePath));
    const inside = this.allowedRoots.some((root) => {
      const rootRealPath = fs.existsSync(root) ? fs.realpathSync(root) : null;
      if (!rootRealPath) return false;
      const relative = path.relative(rootRealPath, parentRealPath);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (!inside) {
      throw new MockConflictError(
        `拒绝在受控目录的真实路径之外写文件: ${absolutePath} -> ${parentRealPath}`,
      );
    }
  }

  /** 内容一致则复用；不存在则创建；内容不一致视为异主文件。 */
  ensure(absolutePath: string, content: Buffer): 'CREATED' | 'REUSED' {
    const absolute = path.resolve(absolutePath);
    this.assertInsideAllowedRoots(absolute);
    assertNoSymlinkComponents(absolute, '原件路径');
    const existing = lstatOrNull(absolute);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new MockConflictError(`目标已是链接或非普通文件，拒绝覆盖: ${absolute}`);
      }
      const current = fs.readFileSync(absolute);
      if (sha256Hex(current) !== sha256Hex(content)) {
        throw new MockConflictError(`文件已存在但内容不同，拒绝覆盖: ${absolute}`);
      }
      return 'REUSED';
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    assertNoSymlinkComponents(absolute, '原件路径');
    this.assertRealParentInsideAllowedRoots(absolute);
    try {
      fs.writeFileSync(absolute, content, { flag: 'wx', mode: 0o640 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new MockConflictError(`文件在写入瞬间被创建，拒绝覆盖: ${absolute}`);
      }
      throw new MockWriteError(`写入原件失败: ${absolute}（${(error as Error).message}）`);
    }
    const stat = fs.lstatSync(absolute);
    this.created.push({ path: absolute, dev: stat.dev, ino: stat.ino, sha256: sha256Hex(content) });
    return 'CREATED';
  }

  /**
   * 回滚时仅回收本次创建的文件。
   *
   * 清理前重新 lstat：必须是普通文件且 dev/ino 与本轮记录一致；不跟随链接，
   * 被替换或无法确认时保留并报告，绝不删除替换物。
   */
  cleanupCreated(): CleanupResult {
    const removed: string[] = [];
    const retained: string[] = [];
    const errors: string[] = [];
    for (const entry of this.created.splice(0)) {
      let stat: fs.Stats | null;
      try {
        stat = lstatOrNull(entry.path);
      } catch (error) {
        errors.push(`${entry.path}: 清理前无法检查（${(error as Error).message}）`);
        continue;
      }
      if (!stat) continue;
      if (stat.isSymbolicLink() || !stat.isFile()) {
        retained.push(`${entry.path}: 已不是本轮创建的普通文件`);
        continue;
      }
      if (stat.dev !== entry.dev || stat.ino !== entry.ino) {
        retained.push(`${entry.path}: inode 已变化，疑似被替换`);
        continue;
      }
      let currentSha256: string;
      try {
        currentSha256 = sha256Hex(fs.readFileSync(entry.path));
      } catch (error) {
        errors.push(`${entry.path}: 清理前无法读取内容（${(error as Error).message}）`);
        continue;
      }
      if (currentSha256 !== entry.sha256) {
        retained.push(`${entry.path}: 内容已变化，疑似被替换`);
        continue;
      }
      try {
        fs.unlinkSync(entry.path);
        removed.push(entry.path);
      } catch (error) {
        errors.push(`${entry.path}: 删除失败（${(error as Error).message}）`);
      }
    }
    return { removed, retained, errors };
  }

  /** 本轮创建的文件清单（提交结果未知时用于保留诊断）。 */
  createdPaths(): readonly string[] {
    return this.created.map((entry) => entry.path);
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
  const absolute = path.resolve(filePath);
  assertNoSymlinkComponents(absolute, '凭据文件');
  const existing = lstatOrNull(absolute);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new MockWriteError(`凭据文件已是链接或非普通文件，拒绝写入: ${absolute}`);
    }
    return false;
  }
  const serialized = `${JSON.stringify(content, null, 2)}\n`;
  try {
    fs.writeFileSync(absolute, serialized, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw new MockWriteError(`写入凭据文件失败: ${absolute}（${(error as Error).message}）`);
  }
}

/**
 * 统计 JSON 输出：每次运行必须是新文件。
 *
 * 预检已在写库前拒绝已占用路径；这里保留排他创建，防止预检后出现的文件被覆盖。
 * 已存在（含内容一致）同样拒绝，避免把旧统计误当成本次运行结果。
 */
export function writeJsonFileExclusive(filePath: string, content: unknown): void {
  const absolute = path.resolve(filePath);
  assertNoSymlinkComponents(absolute, '统计输出文件');
  const serialized = `${JSON.stringify(content, null, 2)}\n`;
  if (lstatOrNull(absolute)) {
    throw new MockWriteError(
      `统计输出已存在，拒绝覆盖: ${absolute}；请使用新的统计文件名或省略 --json-out`,
    );
  }
  try {
    fs.writeFileSync(absolute, serialized, { flag: 'wx', mode: 0o640 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new MockWriteError(
        `统计输出在写入瞬间被创建，拒绝覆盖: ${absolute}；请使用新的统计文件名或省略 --json-out`,
      );
    }
    throw new MockWriteError(`写入统计输出失败: ${absolute}（${(error as Error).message}）`);
  }
}
