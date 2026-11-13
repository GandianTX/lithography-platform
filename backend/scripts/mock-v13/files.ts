// scripts/mock-v13/files.ts

/**
 * Mock 原件的真实文件与记录包样例。
 *
 * 只写入 `--mock-file-dir` / `--reference-storage-dir` 指定目录；文件内容由稳定键派生，
 * 重跑时内容一致即复用，不一致视为异主文件并拒绝覆盖。事务失败时只删除本次新建的文件。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { GuardViolationError, MockConflictError, MockWriteError } from './errors';
import { assertNoSymlinkComponents } from './guard';
import { MOCK_LABEL, MOCK_PREFIX } from './manifest';

/** 每个原件根内的持久归属标记；不含密钥，仅记录实例 UUID、库名和根用途。 */
export const MOCK_ROOT_OWNER_FILE = '.mock-v13-owner.json';

export type MockRootRole = 'mock-file-dir' | 'reference-storage-dir';

export interface MockRootTarget {
  readonly flag: '--mock-file-dir' | '--reference-storage-dir';
  readonly dir: string;
}

export interface RootOwner {
  readonly instanceUuid: string;
  readonly database: string;
}

interface RootOwnerMarker {
  readonly version: 1;
  readonly mock: true;
  readonly role: MockRootRole;
  readonly root: string;
  readonly instance_uuid: string;
  readonly database: string;
  readonly claimed_at: string;
}

export interface MockRootClaim {
  readonly root: string;
  readonly role: MockRootRole;
  readonly flag: MockRootTarget['flag'];
  readonly markerPath: string;
  readonly instanceUuid: string;
  readonly database: string;
}

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

/**
 * 本次运行创建的文件记录：排他打开成功后立即登记路径（身份待确认），
 * fstat 成功后才补齐对象身份；之后的写入失败（如 ENOSPC）也会留下可回收的残件记录。
 */
interface CreatedFile {
  readonly path: string;
  /** 排他打开后尚未完成 fstat 时为 null；此时不能证明对象归属。 */
  dev: number | null;
  ino: number | null;
  birthtimeMs: number | null;
  /** 完整写入并核对后才有值；部分写入的残件不能按完整哈希判断归属。 */
  sha256: string | null;
}

export interface FileWriteHooks {
  /** 仅测试注入：在 fstat 读取文件身份前调用，可抛错模拟身份登记失败。 */
  readonly beforeReadFileIdentity?: (fd: number, targetPath: string) => void;
  /** 仅测试注入：在写入内容前调用，可先写部分字节再抛错模拟 ENOSPC。 */
  readonly beforeWriteContent?: (fd: number, content: Buffer) => void;
}

/** 仅测试注入：归属标记创建过程中的故障点。 */
export interface RootClaimHooks {
  /** 仅测试注入：在 fstat 读取标记临时文件身份前调用，可抛错。 */
  readonly beforeReadIdentity?: (fd: number, tempPath: string) => void;
  /** 仅测试注入：在原子发布归属标记前调用，可抛错模拟第二根发布失败。 */
  readonly beforePublish?: (claim: MockRootClaim, index: number) => void;
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

function writeAllToFd(fd: number, content: Buffer): void {
  let offset = 0;
  while (offset < content.length) {
    const written = fs.writeSync(fd, content, offset, content.length - offset, offset);
    if (written <= 0) {
      throw new Error('写入返回 0 字节');
    }
    offset += written;
  }
}

function describeRootOwner(marker: RootOwnerMarker): string {
  return `实例=${marker.instance_uuid} 库=${marker.database}`;
}

function parseOwnerMarker(raw: string, expected: MockRootClaim): RootOwnerMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GuardViolationError(
      `${expected.flag} 的归属标记无法解析: ${expected.markerPath}，拒绝自动认领或清理`,
    );
  }
  const marker = parsed as Partial<RootOwnerMarker>;
  if (
    marker.version !== 1 ||
    marker.mock !== true ||
    typeof marker.role !== 'string' ||
    typeof marker.root !== 'string' ||
    typeof marker.instance_uuid !== 'string' ||
    typeof marker.database !== 'string'
  ) {
    throw new GuardViolationError(
      `${expected.flag} 的归属标记格式不可信: ${expected.markerPath}，拒绝自动认领或清理`,
    );
  }
  if (marker.role !== expected.role || path.resolve(marker.root) !== expected.root) {
    throw new GuardViolationError(
      `${expected.flag} 的归属标记不属于该根: ${expected.markerPath}，拒绝自动认领或清理`,
    );
  }
  return marker as RootOwnerMarker;
}

function assertMarkerOwner(marker: RootOwnerMarker, expected: MockRootClaim): void {
  if (
    marker.instance_uuid.toLowerCase() !== expected.instanceUuid.toLowerCase() ||
    marker.database !== expected.database
  ) {
    throw new GuardViolationError(
      `${expected.flag} 已被其它实例或库认领（${describeRootOwner(marker)}），本次为 实例=${
        expected.instanceUuid
      } 库=${expected.database}，拒绝复用同一原件根`,
    );
  }
}

function readExistingClaim(target: MockRootTarget, owner: RootOwner): MockRootClaim {
  const root = path.resolve(target.dir);
  const markerPath = path.join(root, MOCK_ROOT_OWNER_FILE);
  const claim: MockRootClaim = {
    root,
    role: target.flag === '--mock-file-dir' ? 'mock-file-dir' : 'reference-storage-dir',
    flag: target.flag,
    markerPath,
    instanceUuid: owner.instanceUuid,
    database: owner.database,
  };
  const markerStat = lstatOrNull(markerPath);
  if (!markerStat) return claim;
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
    throw new GuardViolationError(
      `${target.flag} 的归属标记不是普通文件: ${markerPath}，拒绝自动认领或清理`,
    );
  }
  const marker = parseOwnerMarker(fs.readFileSync(markerPath, 'utf8'), claim);
  assertMarkerOwner(marker, claim);
  return claim;
}

/** 回收一个已登记身份的临时文件；不能证明归属时保留并给出原因。 */
function reclaimOwnedFile(entry: CreatedFile): {
  readonly outcome: 'REMOVED' | 'MISSING' | 'RETAINED';
  readonly detail: string | null;
} {
  let stat: fs.Stats | null;
  try {
    stat = lstatOrNull(entry.path);
  } catch (error) {
    return { outcome: 'RETAINED', detail: `清理前无法检查（${(error as Error).message}）` };
  }
  if (!stat) return { outcome: 'MISSING', detail: null };
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { outcome: 'RETAINED', detail: '已不是本轮创建的普通文件' };
  }
  if (entry.dev === null || entry.ino === null || entry.birthtimeMs === null) {
    return { outcome: 'RETAINED', detail: '身份未能登记，无法证明仍是本轮创建对象' };
  }
  if (stat.dev !== entry.dev || stat.ino !== entry.ino || stat.birthtimeMs !== entry.birthtimeMs) {
    return { outcome: 'RETAINED', detail: '对象身份已变化，疑似被替换' };
  }
  try {
    fs.unlinkSync(entry.path);
    return { outcome: 'REMOVED', detail: null };
  } catch (error) {
    return { outcome: 'RETAINED', detail: `删除失败（${(error as Error).message}）` };
  }
}

function describeReclaim(entry: CreatedFile, reclaim: ReturnType<typeof reclaimOwnedFile>): string {
  if (reclaim.outcome === 'RETAINED') {
    return `；临时文件 ${entry.path} 无法证明归属，已保留（${reclaim.detail ?? '原因不明'}）`;
  }
  return `；临时文件 ${entry.path} 已${reclaim.outcome === 'REMOVED' ? '回收' : '不存在'}`;
}

/**
 * 空根的首个认领：先在受控位置完整写入并关闭临时标记，再以不覆盖既有标记的方式原子发布。
 *
 * - fstat/写入/关闭失败：只回收身份可证的本轮临时文件；无法证明归属时保留并诊断；
 * - 发布失败：正式路径不会出现空文件或半写标记；并发 EEXIST 仍按内容核对归属。
 */
function createExclusiveClaim(claim: MockRootClaim, index: number, hooks: RootClaimHooks): void {
  const serialized = `${JSON.stringify(
    {
      version: 1,
      mock: true,
      role: claim.role,
      root: claim.root,
      instance_uuid: claim.instanceUuid,
      database: claim.database,
      claimed_at: new Date().toISOString(),
    } satisfies RootOwnerMarker,
    null,
    2,
  )}\n`;
  const tempPath = path.join(
    claim.root,
    `${MOCK_ROOT_OWNER_FILE}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`,
  );
  let fd: number;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o640);
  } catch (error) {
    throw new MockWriteError(
      `无法在 ${claim.flag} 建立归属标记临时文件（${tempPath}）：${(error as Error).message}`,
    );
  }
  const entry: CreatedFile = {
    path: tempPath,
    dev: null,
    ino: null,
    birthtimeMs: null,
    sha256: null,
  };
  let failure: Error | null = null;
  try {
    hooks.beforeReadIdentity?.(fd, tempPath);
    const opened = fs.fstatSync(fd);
    entry.dev = opened.dev;
    entry.ino = opened.ino;
    entry.birthtimeMs = opened.birthtimeMs;
    writeAllToFd(fd, Buffer.from(serialized, 'utf8'));
    fs.fsyncSync(fd);
    entry.sha256 = sha256Hex(Buffer.from(serialized, 'utf8'));
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    try {
      fs.closeSync(fd);
    } catch (error) {
      if (!failure) {
        failure = new Error(`关闭归属标记临时文件失败：${(error as Error).message}`);
      }
    }
  }
  if (failure) {
    const note = describeReclaim(entry, reclaimOwnedFile(entry));
    throw new MockWriteError(
      `写入 ${claim.flag} 归属标记失败（${tempPath}）：${failure.message}${note}`,
    );
  }
  try {
    hooks.beforePublish?.(claim, index);
    fs.linkSync(tempPath, claim.markerPath);
  } catch (error) {
    const note = describeReclaim(entry, reclaimOwnedFile(entry));
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // 并发认领：另一个进程刚发布了标记，必须重新按内容核对归属。
      if (!lstatOrNull(claim.markerPath)) {
        throw new GuardViolationError(
          `${claim.flag} 认领竞态后仍缺少归属标记: ${claim.markerPath}，拒绝继续${note}`,
        );
      }
      try {
        readExistingClaim(
          { flag: claim.flag, dir: claim.root },
          { instanceUuid: claim.instanceUuid, database: claim.database },
        );
      } catch (conflict) {
        const message = conflict instanceof Error ? conflict.message : String(conflict);
        throw new GuardViolationError(`${message}${note}`);
      }
      return;
    }
    throw new MockWriteError(
      `发布 ${claim.flag} 归属标记失败（${claim.markerPath}）：${(error as Error).message}${note}`,
    );
  }
  try {
    fs.unlinkSync(tempPath);
  } catch (error) {
    // 正式标记已发布，临时名残留不影响归属；只做诊断。
    process.stderr.write(
      `[mock:v13] ${claim.flag} 归属标记已发布，但临时文件未能移除（${tempPath}）：${(error as Error).message}\n`,
    );
  }
}

/**
 * 在完成实例 UUID 与库名核对后、任何业务写入与原件复用前，为两个原件根建立持久归属。
 *
 * - 已有可信标记：实例与库必须同时一致，否则拒绝；
 * - 无标记且目录非空：拒绝自动认领，也不清理任何内容；
 * - 无标记且目录为空（或尚不存在）：以排他创建写入标记。
 *
 * 标记是持久归属，不随业务事务回滚删除。
 */
export function claimMockRoots(
  targets: readonly MockRootTarget[],
  owner: RootOwner,
  hooks: RootClaimHooks = {},
): MockRootClaim[] {
  if (!owner.instanceUuid || !owner.database) {
    throw new GuardViolationError('原件根认领缺少实际实例 UUID 或库名，拒绝写入');
  }
  const resolved = targets.map((target) => path.resolve(target.dir));
  if (resolved[0] === resolved[1]) {
    throw new GuardViolationError('--mock-file-dir 与 --reference-storage-dir 必须指向不同目录');
  }
  const nested = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  if (nested(resolved[0], resolved[1]) || nested(resolved[1], resolved[0])) {
    throw new GuardViolationError(
      '--mock-file-dir 与 --reference-storage-dir 不能相互嵌套，拒绝认领原件根',
    );
  }

  const claims: MockRootClaim[] = [];
  const needsClaim: MockRootClaim[] = [];
  for (const target of targets) {
    const root = path.resolve(target.dir);
    const markerPath = path.join(root, MOCK_ROOT_OWNER_FILE);
    const existing = lstatOrNull(root);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new GuardViolationError(`${target.flag} 已存在但不是目录: ${root}`);
      }
      // 路径别名会让同一物理目录看起来像两个根，认领前同样拒绝符号链接组件。
      assertNoSymlinkComponents(root, target.flag);
      if (lstatOrNull(markerPath)) {
        claims.push(readExistingClaim(target, owner));
        continue;
      }
      const entries = fs.readdirSync(root);
      if (entries.length > 0) {
        throw new GuardViolationError(
          `${target.flag} 已有内容但没有可信归属标记（${entries.slice(0, 3).join(', ')}${
            entries.length > 3 ? '…' : ''
          }），拒绝自动认领或清理: ${root}`,
        );
      }
    }
    needsClaim.push(readExistingClaim(target, owner));
  }

  for (const [index, claim] of needsClaim.entries()) {
    fs.mkdirSync(claim.root, { recursive: true });
    assertNoSymlinkComponents(claim.root, claim.flag);
    // 目录创建到排他认领之间若出现任何内容，视为不可信旧目录，不再补归属。
    const entries = fs.readdirSync(claim.root);
    if (entries.length > 0) {
      throw new GuardViolationError(
        `${claim.flag} 在认领前出现内容（${entries.slice(0, 3).join(', ')}${
          entries.length > 3 ? '…' : ''
        }），拒绝自动认领: ${claim.root}`,
      );
    }
    createExclusiveClaim(claim, index, hooks);
    claims.push(claim);
  }
  return claims;
}

/** 文件登记器：只删除本次运行创建、且仍能确认对象身份的文件。 */
export class FileRegistry {
  private readonly created: CreatedFile[] = [];
  private readonly allowedRoots: readonly string[];
  private readonly hooks: FileWriteHooks;

  constructor(allowedRoots: readonly string[], hooks: FileWriteHooks = {}) {
    this.allowedRoots = allowedRoots.map((root) => path.resolve(root));
    this.hooks = hooks;
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
    let fd: number;
    try {
      fd = fs.openSync(absolute, 'wx', 0o640);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new MockConflictError(`文件在写入瞬间被创建，拒绝覆盖: ${absolute}`);
      }
      throw new MockWriteError(`写入原件失败: ${absolute}（${(error as Error).message}）`);
    }
    // 排他打开成功即登记路径；fstat 之前身份为“待确认”，清理时不得删除。
    const entry: CreatedFile = {
      path: absolute,
      dev: null,
      ino: null,
      birthtimeMs: null,
      sha256: null,
    };
    this.created.push(entry);
    let failure: Error | null = null;
    try {
      this.hooks.beforeReadFileIdentity?.(fd, absolute);
      const opened = fs.fstatSync(fd);
      entry.dev = opened.dev;
      entry.ino = opened.ino;
      entry.birthtimeMs = opened.birthtimeMs;
      if (this.hooks.beforeWriteContent) {
        this.hooks.beforeWriteContent(fd, content);
      }
      writeAllToFd(fd, content);
      fs.fsyncSync(fd);
      entry.sha256 = sha256Hex(content);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      try {
        fs.closeSync(fd);
      } catch (error) {
        // 关闭失败不覆盖原始写入结果；残件仍留在本轮登记表中，由收尾统一诊断。
        if (!failure) {
          failure = new Error(`关闭原件失败：${(error as Error).message}`);
        }
      }
    }
    if (failure) {
      throw new MockWriteError(`写入原件失败: ${absolute}（${failure.message}）`);
    }
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
      if (entry.dev === null || entry.ino === null || entry.birthtimeMs === null) {
        retained.push(`${entry.path}: 文件身份未能登记，无法证明仍是本轮创建对象`);
        continue;
      }
      if (
        stat.dev !== entry.dev ||
        stat.ino !== entry.ino ||
        stat.birthtimeMs !== entry.birthtimeMs
      ) {
        retained.push(`${entry.path}: 对象身份已变化，疑似被替换`);
        continue;
      }
      if (entry.sha256 !== null) {
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
 * 受控凭据文件：0600，且只接受新路径。
 *
 * 预检已在连库/建目录前拒绝已占用路径；这里保留排他创建，防止预检后出现的文件被覆盖。
 * 提交后才发现目标被占用属于收尾失败，由调用方按退出码 6 处理。
 */
export function writeCredentialsFile(filePath: string, content: CredentialFileContent): void {
  const absolute = path.resolve(filePath);
  assertNoSymlinkComponents(absolute, '凭据文件');
  const existing = lstatOrNull(absolute);
  if (existing) {
    throw new MockWriteError(
      `凭据文件已存在，拒绝覆盖: ${absolute}；请改用新文件名，或重跑时省略 --credentials-out`,
    );
  }
  const serialized = `${JSON.stringify(content, null, 2)}\n`;
  try {
    fs.writeFileSync(absolute, serialized, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new MockWriteError(
        `凭据文件在写入瞬间被创建，拒绝覆盖: ${absolute}；请改用新文件名，或重跑时省略 --credentials-out`,
      );
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
