import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { FileHandle } from 'node:fs/promises';

/**
 * 开发联调样例原件的最小写入/核对能力。
 *
 * 与 `LocalReferenceDocumentStorage` 共用同一套安全前提：存储引用无路径语义、
 * 写入前断言仍在目标目录内。这里的目录守卫额外要求目录属于目标库（以库名结尾）、
 * 不是共享根、路径不含符号链接，避免把样例原件写进共用存储或无法确认归属的目录。
 *
 * 归属模型：
 * - 目录首次使用时以排他方式写入归属标记（实际实例 UUID + 精确库名）；
 * - 先在库专属目录内排他创建私有暂存对象，写入并回读校验后才以不覆盖方式发布到最终路径；
 * - 只有成功取得暂存句柄并记录对象身份（dev+ino）的原件才登记为本轮所有；
 * - 共享原件目录没有可证明的独占目录项边界：核对与 unlink 无法原子绑定，核对后、删除前
 *   路径仍可能被其他写入方替换。因此不按路径自动删除，登记路径一律保留并报告，由人工处置。
 *   随机文件名与打开的句柄都不能单独作为删除授权。
 */
export const DEV_SAMPLE_FILE_MIME_TYPE = 'text/plain';
export const DEV_SAMPLE_FILE_EXTENSION = 'txt';
export const DEV_SAMPLE_FILE_MAX_BYTES = 64 * 1024;
export const DEV_SAMPLE_DIRECTORY_MARKER = '.lithography-dev-sample-owner.json';

const STORAGE_REFERENCE_PATTERN = /^[0-9a-f]{32}\.txt$/;
const STAGING_OBJECT_PATTERN = /^\.dev-sample-staging-[0-9a-f]{32}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OWNER_FORMAT_VERSION = 1;
const OWNER_MARKER_MAX_BYTES = 4096;

export interface DevSampleFileSpec {
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly content: Buffer;
}

export type DevSampleFileState = 'VERIFIED' | 'MISSING' | 'MISMATCH';
export type DevSampleFileRemoval = 'DELETED' | 'RETAINED';

export interface DevSampleFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface DevSampleDirectoryOwnership {
  readonly directory: string;
  readonly database: string;
  readonly serverUuid: string;
  readonly markerPath: string;
  readonly markerIdentity: DevSampleFileIdentity;
}

export interface DevSampleFileClaim {
  readonly storageReference: string;
  /** 暂存对象路径；发布成功后该硬链接同样保留，用于报告与人工处置。 */
  readonly stagingPath: string;
  /** 最终发布路径（稳定 storage_reference 对应的路径）。 */
  readonly finalPath: string;
  /** 已通过不覆盖发布把暂存对象链接到 finalPath。 */
  readonly published: boolean;
  /** 当前对象路径：未发布为暂存路径，已发布为最终路径。 */
  readonly filePath: string;
  readonly identity: DevSampleFileIdentity;
  readonly ownership: DevSampleDirectoryOwnership;
  /** 句柄仍存活时返回句柄当前身份；已关闭或句柄失效返回 null。 */
  currentIdentity(): Promise<DevSampleFileIdentity | null>;
  /** 收尾句柄；幂等。关闭失败会抛出，由调用方追加诊断。 */
  close(): Promise<void>;
}

class DevSampleFileClaimHandle implements DevSampleFileClaim {
  private handle: FileHandle | null;
  private isPublished = false;

  constructor(
    readonly storageReference: string,
    readonly stagingPath: string,
    readonly finalPath: string,
    readonly identity: DevSampleFileIdentity,
    readonly ownership: DevSampleDirectoryOwnership,
    handle: FileHandle,
  ) {
    this.handle = handle;
  }

  get published(): boolean {
    return this.isPublished;
  }

  get filePath(): string {
    return this.isPublished ? this.finalPath : this.stagingPath;
  }

  markPublished(): void {
    this.isPublished = true;
  }

  async currentIdentity(): Promise<DevSampleFileIdentity | null> {
    const handle = this.handle;
    if (handle === null) {
      return null;
    }
    try {
      return identityOf(await handle.stat());
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    const handle = this.handle;
    if (handle === null) {
      return;
    }
    this.handle = null;
    await handle.close();
  }
}

export interface DevSampleFileWriteResult {
  readonly storageReference: string;
  /** 仅当目录归属已确认并成功取得排他句柄时非空。 */
  readonly claim: DevSampleFileClaim | null;
}

export interface DevSampleFileWriteOptions {
  /** 固定存储引用；资料样例必须由不可变 seed_key 派生，重跑才能稳定匹配。 */
  readonly storageReference?: string;
  readonly ownership?: DevSampleDirectoryOwnership | null;
  /** 取得句柄并记录对象身份后立即回调，确保失败路径也能精确处置。 */
  readonly onClaim?: (claim: DevSampleFileClaim) => void;
  /** 测试注入点：默认通过句柄写入完整内容。 */
  readonly writeContent?: (handle: FileHandle, content: Buffer) => Promise<void>;
  /** 测试注入点：默认通过句柄读取对象身份。 */
  readonly readIdentity?: (handle: FileHandle) => Promise<{
    readonly isFile: () => boolean;
    readonly dev: number | bigint;
    readonly ino: number | bigint;
  }>;
}

export function assertSha256(value: string, label: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} 必须是 64 位小写十六进制 SHA-256`);
  }
  return value;
}

export function sha256Of(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 由不可变 seed_key 派生稳定存储引用。
 *
 * 引用保持无路径语义的 32 位小写十六进制；同一 seed_key 在任意实例、任意标题下
 * 都得到同一引用，标题只用于展示，不参与认领。
 */
export function deriveDevSampleStorageReference(seedKey: string): string {
  if (typeof seedKey !== 'string' || seedKey.trim().length === 0) {
    throw new Error('资料样例 seed_key 不能为空');
  }
  const digest = createHash('sha256')
    .update(`lithography-dev-sample-reference:v1\n${seedKey}`, 'utf8')
    .digest('hex');
  return `${digest.slice(0, 32)}.${DEV_SAMPLE_FILE_EXTENSION}`;
}

/**
 * 目标库专属原件目录守卫。
 *
 * - 必须是绝对路径，且目录名必须等于目标库名（防止共用目录）；
 * - 拒绝文件系统根、家目录、临时目录根、当前工作目录及其父目录等共享位置；
 * - 目录必须预先存在、本身不是符号链接，realpath 必须与解析结果一致
 *   （任一路径分段是符号链接都会被拒绝）。
 */
export function assertDevSampleFilesDirectory(directory: string, database: string): void {
  if (typeof directory !== 'string' || directory.trim().length === 0) {
    throw new Error('开发样例原件目录不能为空');
  }
  if (!path.isAbsolute(directory)) {
    throw new Error(`开发样例原件目录必须是绝对路径：${directory}`);
  }
  const resolved = path.resolve(directory);
  if (path.basename(resolved) !== database) {
    throw new Error(
      `开发样例原件目录必须是目标库专属目录，目录名须等于目标库名 ${database}：${resolved}`,
    );
  }

  const sharedRoots = new Set([
    path.parse(resolved).root,
    os.homedir(),
    os.tmpdir(),
    process.cwd(),
    path.dirname(process.cwd()),
  ]);
  if (sharedRoots.has(resolved)) {
    throw new Error(`开发样例原件目录拒绝使用共享根目录：${resolved}`);
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new Error(`开发样例原件目录不存在，请与目标库一起预建：${resolved}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`开发样例原件目录必须是真实目录，不得为符号链接：${resolved}`);
  }

  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch {
    throw new Error(`无法解析开发样例原件目录的真实路径：${resolved}`);
  }
  if (realPath !== resolved) {
    throw new Error(`开发样例原件目录路径包含符号链接或未规范化，拒绝使用：${resolved}`);
  }
}

/** 校验存储引用格式并解析为目录内绝对路径；越界、分隔符与 `..` 一律拒绝。 */
function resolveSampleFile(directory: string, storageReference: string): string {
  if (!STORAGE_REFERENCE_PATTERN.test(storageReference)) {
    throw new Error(`开发样例原件存储引用格式非法：${storageReference}`);
  }
  const baseDir = path.resolve(directory);
  const resolved = path.resolve(baseDir, storageReference);
  if (!resolved.startsWith(baseDir + path.sep)) {
    throw new Error(`开发样例原件存储引用越出目标目录：${storageReference}`);
  }
  return resolved;
}

interface OwnerMarkerRecord {
  readonly database: string;
  readonly serverUuid: string;
  readonly stat: fs.Stats;
}

function identityOf(stat: {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}): DevSampleFileIdentity {
  return { device: BigInt(stat.dev), inode: BigInt(stat.ino) };
}

function sameIdentity(left: DevSampleFileIdentity, right: DevSampleFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code?: unknown }).code)
    : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readOwnerMarker(markerPath: string): Promise<OwnerMarkerRecord | null> {
  let stat: fs.Stats;
  try {
    stat = await fsp.lstat(markerPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`开发样例原件目录归属标记必须是普通文件，不得为符号链接：${markerPath}`);
  }
  if (stat.size > OWNER_MARKER_MAX_BYTES) {
    throw new Error(`开发样例原件目录归属标记异常过大：${markerPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(markerPath, 'utf8'));
  } catch (error) {
    throw new Error(`开发样例原件目录归属标记无法解析：${markerPath}`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`开发样例原件目录归属标记格式非法：${markerPath}`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.format_version !== OWNER_FORMAT_VERSION) {
    throw new Error(`开发样例原件目录归属标记版本不支持：${markerPath}`);
  }
  if (typeof record.database !== 'string' || typeof record.server_uuid !== 'string') {
    throw new Error(`开发样例原件目录归属标记缺少库名或实例 UUID：${markerPath}`);
  }
  return { database: record.database, serverUuid: record.server_uuid, stat };
}

function ownershipOf(
  directory: string,
  markerPath: string,
  marker: OwnerMarkerRecord,
): DevSampleDirectoryOwnership {
  return {
    directory,
    database: marker.database,
    serverUuid: marker.serverUuid,
    markerPath,
    markerIdentity: identityOf(marker.stat),
  };
}

function assertMarkerMatches(
  marker: OwnerMarkerRecord,
  markerPath: string,
  database: string,
  serverUuid: string,
): void {
  if (marker.database !== database || marker.serverUuid !== serverUuid) {
    throw new Error(
      `开发样例原件目录归属不匹配：期望 ${database}@${serverUuid}，` +
        `实际 ${marker.database}@${marker.serverUuid}；拒绝复用并保留现场（${markerPath}）`,
    );
  }
}

/**
 * 首次认领目标库专属原件目录；已认领时只核对实例 UUID 与精确库名。
 *
 * 非空且没有可信归属标记的旧目录一律拒绝，不自动补标记、不清理现场。
 * 同一实例同一库可重复认领；另一实例的同名库不得复用该目录。
 */
export async function claimDevSampleFilesDirectory(
  directory: string,
  database: string,
  serverUuid: string,
): Promise<DevSampleDirectoryOwnership> {
  assertDevSampleFilesDirectory(directory, database);
  const expectedUuid = serverUuid.trim().toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(expectedUuid)) {
    throw new Error(`开发样例原件目录认领需要合法实例 UUID：${serverUuid}`);
  }
  const resolved = path.resolve(directory);
  const markerPath = path.join(resolved, DEV_SAMPLE_DIRECTORY_MARKER);

  const existing = await readOwnerMarker(markerPath);
  if (existing !== null) {
    assertMarkerMatches(existing, markerPath, database, expectedUuid);
    return ownershipOf(resolved, markerPath, existing);
  }

  const entries = await fsp.readdir(resolved);
  if (entries.length > 0) {
    throw new Error(`开发样例原件目录非空且无可信归属标记，拒绝认领并保留现场：${resolved}`);
  }

  let handle: FileHandle | null = null;
  let writeError: unknown = null;
  try {
    handle = await fsp.open(markerPath, 'wx');
    await handle.writeFile(
      Buffer.from(
        `${JSON.stringify({
          format_version: OWNER_FORMAT_VERSION,
          database,
          server_uuid: expectedUuid,
        })}\n`,
        'utf8',
      ),
    );
    await handle.sync();
  } catch (error) {
    writeError = error;
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch (error) {
        if (writeError === null) {
          writeError = error;
        }
      }
    }
  }
  if (writeError !== null) {
    if (errorCode(writeError) !== 'EEXIST') {
      throw writeError;
    }
    const raced = await readOwnerMarker(markerPath);
    if (raced === null) {
      throw writeError;
    }
    assertMarkerMatches(raced, markerPath, database, expectedUuid);
    return ownershipOf(resolved, markerPath, raced);
  }

  const marker = await readOwnerMarker(markerPath);
  if (marker === null) {
    throw new Error(`开发样例原件目录归属标记写入后不可见：${markerPath}`);
  }
  assertMarkerMatches(marker, markerPath, database, expectedUuid);
  return ownershipOf(resolved, markerPath, marker);
}

async function assertOwnershipStillCurrent(ownership: DevSampleDirectoryOwnership): Promise<void> {
  const marker = await readOwnerMarker(ownership.markerPath);
  if (marker === null) {
    throw new Error(`开发样例原件目录归属标记已丢失：${ownership.markerPath}`);
  }
  assertMarkerMatches(marker, ownership.markerPath, ownership.database, ownership.serverUuid);
  if (!sameIdentity(identityOf(marker.stat), ownership.markerIdentity)) {
    throw new Error(`开发样例原件目录归属标记已被替换：${ownership.markerPath}`);
  }
}

/**
 * 写入一份样例原件：私有暂存 → 回读校验 → 不覆盖发布。
 *
 * 最终路径不会出现半截文件：写入只发生在本轮排他创建的暂存对象上，字节数与哈希
 * 校验通过后才以 hard link（不覆盖）发布。EEXIST 时不认领、不覆盖、不删除既有文件。
 * 取得句柄后立即登记；失败时若已登记，句柄保留到事务收尾决定，由调用方保留并关闭。
 */
export async function writeDevSampleFile(
  directory: string,
  spec: DevSampleFileSpec,
  options: DevSampleFileWriteOptions = {},
): Promise<DevSampleFileWriteResult> {
  const storageReference =
    options.storageReference ?? `${randomBytes(16).toString('hex')}.${DEV_SAMPLE_FILE_EXTENSION}`;
  const target = resolveSampleFile(directory, storageReference);
  const ownership = options.ownership ?? null;

  if (ownership !== null) {
    await assertOwnershipStillCurrent(ownership);
  }
  await assertTargetAbsent(target);

  const stagingPath = resolveStagingPath(directory);
  let handle: FileHandle | null = null;
  let claim: DevSampleFileClaimHandle | null = null;
  let mainError: unknown = null;

  try {
    handle = await fsp.open(stagingPath, 'wx+', 0o600);
    const stat = await (options.readIdentity ?? ((file: FileHandle) => file.stat()))(handle);
    if (!stat.isFile()) {
      throw new Error(`开发样例原件暂存对象不是普通文件：${stagingPath}`);
    }
    if (ownership !== null) {
      claim = new DevSampleFileClaimHandle(
        storageReference,
        stagingPath,
        target,
        identityOf(stat),
        ownership,
        handle,
      );
      options.onClaim?.(claim);
    }
    const writeContent =
      options.writeContent ?? ((file: FileHandle, content: Buffer) => file.writeFile(content));
    await writeContent(handle, spec.content);
    await handle.sync();
    const written = await readHandleContent(handle, spec.byteSize);
    if (written.byteLength !== spec.byteSize || sha256Of(written) !== spec.sha256) {
      throw new Error(`开发样例原件写入后核对失败：${spec.originalFilename}`);
    }

    const stagingStat = await fsp.lstat(stagingPath, { bigint: true });
    const handleStat = await handle.stat({ bigint: true });
    if (!stagingStat.isFile() || !sameIdentity(identityOf(stagingStat), identityOf(handleStat))) {
      throw new Error(`开发样例原件暂存路径已被替换，拒绝发布：${stagingPath}`);
    }
    try {
      await linkVerifiedHandle(handle, target);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        throw annotateError(error, [
          `最终路径已存在，未认领、未覆盖、未删除既有文件：${target}`,
        ]);
      }
      throw error;
    }
    claim?.markPublished();
    // 共享原件目录没有可证的独占目录项边界：暂存路径在核对后仍可能被替换，
    // 因此不自动 unlink 暂存链接。成功发布后的暂存硬链接按安全策略保留并报告。

    if (claim === null) {
      await closeHandle(handle);
      handle = null;
    }
    return { storageReference, claim };
  } catch (error) {
    mainError = error;
  }

  if (mainError === null) {
    mainError = new Error('开发样例原件写入失败但未捕获到错误');
  }

  const notes: string[] = [];
  if (claim === null) {
    if (handle !== null) {
      try {
        await closeHandle(handle);
        handle = null;
      } catch (closeFailure) {
        notes.push(`关闭暂存句柄失败：${messageOf(closeFailure)}`);
      }
    }
    notes.push(`未登记本轮原件归属，已保留暂存现场：${stagingPath}`);
    throw annotateError(mainError, notes);
  }

  const anchor = claim.published ? claim.finalPath : claim.stagingPath;
  notes.push(
    claim.published
      ? `最终路径已发布，事务收尾不得按路径自动删除：${anchor}`
      : `暂存对象已登记，事务收尾不得按路径自动删除：${anchor}`,
  );
  throw annotateError(mainError, notes);
}

/** Linux：把已校验句柄传给 ln；不再用可被替换的暂存路径作为发布源。 */
async function linkVerifiedHandle(handle: FileHandle, target: string): Promise<void> {
  if (process.platform !== 'linux') {
    throw new Error('当前平台不支持基于文件句柄发布开发样例原件');
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/ln', ['-L', '-T', '--', '/proc/self/fd/3', target], {
        stdio: ['ignore', 'ignore', 'ignore', handle.fd],
      });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`开发样例原件句柄发布失败（${code ?? signal}）：${target}`));
      });
    });
  } catch (error) {
    await assertTargetAbsent(target);
    throw error;
  }
}

/** 在库专属目录内为本轮排他创建随机暂存路径。 */
function resolveStagingPath(directory: string): string {
  const baseDir = path.resolve(directory);
  const name = `.dev-sample-staging-${randomBytes(16).toString('hex')}`;
  if (!STAGING_OBJECT_PATTERN.test(name)) {
    throw new Error(`开发样例暂存对象命名非法：${name}`);
  }
  const resolved = path.resolve(baseDir, name);
  if (!resolved.startsWith(baseDir + path.sep)) {
    throw new Error(`开发样例暂存对象路径越出目标目录：${name}`);
  }
  return resolved;
}

async function assertTargetAbsent(target: string): Promise<void> {
  try {
    await fsp.lstat(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return;
    }
    throw error;
  }
  const error = new Error(
    `开发样例原件最终路径已存在（EEXIST），拒绝认领、覆盖或删除：${target}`,
  );
  throw Object.assign(error, { code: 'EEXIST' });
}

async function readHandleContent(handle: FileHandle, byteSize: number): Promise<Buffer> {
  const stat = await handle.stat();
  if (stat.size !== byteSize) {
    throw new Error(`开发样例原件字节数不一致：期望 ${byteSize}，实际 ${stat.size}`);
  }
  const content = Buffer.alloc(byteSize);
  let offset = 0;
  while (offset < byteSize) {
    const { bytesRead } = await handle.read(content, offset, byteSize - offset, offset);
    if (bytesRead === 0) {
      throw new Error('开发样例原件回读提前结束');
    }
    offset += bytesRead;
  }
  return content;
}

async function closeHandle(handle: FileHandle): Promise<void> {
  await handle.close();
}

/**
 * 共享原件目录中不按路径自动删除已登记对象。
 *
 * 即使句柄仍存活、dev+ino 与目录归属都能核对，也无法在 Node 文件系统 API 中把
 * “核对的对象”和“实际 unlink 的目录项”原子绑定；核对后、删除前路径仍可能被替换。
 * 因此这里只判断是否仍有待人工处置的路径：
 * - 路径均已不存在：DELETED（本轮无需处置）；
 * - 仍有暂存或最终路径：一律 RETAINED，由事务输出路径、终局与原因，禁止自动清理。
 *
 * 正常回滚因此不再保证磁盘零残留；若必须自动清零，需要另行设计可证明的独占边界。
 */
export async function deleteDevSampleFile(
  claim: DevSampleFileClaim,
): Promise<DevSampleFileRemoval> {
  const candidates = claimCandidates(claim);
  const existing = await existingCandidatePaths(candidates);
  return existing.length === 0 ? 'DELETED' : 'RETAINED';
}

function claimCandidates(claim: DevSampleFileClaim): string[] {
  const baseDir = path.resolve(claim.ownership.directory);
  const raw = claim.published ? [claim.finalPath, claim.stagingPath] : [claim.stagingPath];
  const candidates: string[] = [];
  for (const value of raw) {
    const resolved = path.resolve(value);
    if (!resolved.startsWith(baseDir + path.sep)) {
      throw new Error(`开发样例原件待处置路径越出目标目录：${value}`);
    }
    if (!candidates.includes(resolved)) {
      candidates.push(resolved);
    }
  }
  return candidates;
}

async function existingCandidatePaths(candidates: ReadonlyArray<string>): Promise<string[]> {
  const existing: string[] = [];
  for (const candidate of candidates) {
    try {
      await fsp.lstat(candidate);
      existing.push(candidate);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw error;
      }
    }
  }
  return existing;
}

/** 只读核对既有文件；文件缺失返回 MISSING，内容不一致返回 MISMATCH。 */
export async function verifyDevSampleFile(
  directory: string,
  storageReference: string,
  spec: DevSampleFileSpec,
): Promise<DevSampleFileState> {
  const target = resolveSampleFile(directory, storageReference);
  let content: Buffer;
  try {
    content = await fsp.readFile(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return 'MISSING';
    }
    throw error;
  }
  return content.byteLength === spec.byteSize && sha256Of(content) === spec.sha256
    ? 'VERIFIED'
    : 'MISMATCH';
}

function annotateError(error: unknown, notes: ReadonlyArray<string>): unknown {
  if (notes.length === 0) {
    return error;
  }
  if (error instanceof Error) {
    const annotated = error as Error & { cleanupErrors?: ReadonlyArray<string> };
    annotated.cleanupErrors = [...(annotated.cleanupErrors ?? []), ...notes];
    return annotated;
  }
  return new Error(`${messageOf(error)} | ${notes.join(' | ')}`, { cause: error });
}
