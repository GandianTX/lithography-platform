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
 * 目录绑定模型：
 * - 认领时打开目录句柄，并以该句柄核对目录身份与归属标记（实际实例 UUID + 精确库名）；
 * - 归属标记创建、暂存对象创建、最终发布三个写入点全部经目录句柄解析，
 *   不按配置路径重新查找目录；
 * - 发布时同时绑定已校验的源文件句柄与已核验的目录句柄，排他创建、不覆盖；
 * - 发布后、写入资料引用前再次复核配置路径与目录句柄仍指向同一目录，
 *   变化即中止初始化并保留诊断。路径复核只用于发现变化，真正防止越界写入的是句柄绑定；
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
const DIRECTORY_FD_ROOT = '/proc/self/fd';

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
  /** 目录句柄打开时的目录身份（dev + ino）。 */
  readonly directoryIdentity: DevSampleFileIdentity;
  /** 已核验目录句柄的 fd；发布时用于绑定目标目录。 */
  readonly directoryFd: number;
  /** 经目录句柄解析白名单相对名；不接受路径分隔符或 `..`。 */
  objectPath(relativeName: string): string;
  /** 经目录句柄打开目录内对象。 */
  openObject(relativeName: string, flags: string | number, mode?: number): Promise<FileHandle>;
  /** 经目录句柄读取目录项元数据；不存在返回 null。 */
  statObject(relativeName: string): Promise<fs.BigIntStats | null>;
  /** 经目录句柄读取目录项名称。 */
  readEntries(): Promise<string[]>;
  /** 复核配置路径仍指向目录句柄所在目录，并复核归属标记未被替换。 */
  assertPathBinding(): Promise<void>;
  /** 关闭目录句柄；幂等。 */
  close(): Promise<void>;
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

interface OwnerMarkerRecord {
  readonly database: string;
  readonly serverUuid: string;
  readonly identity: DevSampleFileIdentity;
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
      return identityOf(await handle.stat({ bigint: true }));
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

class DevSampleDirectoryHandle implements DevSampleDirectoryOwnership {
  private handle: FileHandle | null;

  constructor(
    readonly directory: string,
    readonly database: string,
    readonly serverUuid: string,
    readonly markerPath: string,
    readonly markerIdentity: DevSampleFileIdentity,
    readonly directoryIdentity: DevSampleFileIdentity,
    handle: FileHandle,
  ) {
    this.handle = handle;
  }

  get directoryFd(): number {
    return this.requireHandle().fd;
  }

  objectPath(relativeName: string): string {
    return objectPathIn(this.requireHandle(), relativeName);
  }

  openObject(relativeName: string, flags: string | number, mode?: number): Promise<FileHandle> {
    assertObjectName(relativeName);
    const handle = this.requireHandle();
    const target = objectPathIn(handle, relativeName);
    return mode === undefined ? fsp.open(target, flags) : fsp.open(target, flags, mode);
  }

  async statObject(relativeName: string): Promise<fs.BigIntStats | null> {
    assertObjectName(relativeName);
    try {
      return await fsp.lstat(objectPathIn(this.requireHandle(), relativeName), { bigint: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  readEntries(): Promise<string[]> {
    return fsp.readdir(directoryFdPath(this.requireHandle()));
  }

  async assertPathBinding(): Promise<void> {
    const handle = this.requireHandle();
    const handleStat = await handle.stat({ bigint: true });
    if (!handleStat.isDirectory()) {
      throw new Error(`开发样例原件目录句柄已不是目录：${this.directory}`);
    }
    if (!sameIdentity(identityOf(handleStat), this.directoryIdentity)) {
      throw new Error(
        `开发样例原件目录句柄身份已变化：${this.directory} ` +
          `expected=${formatIdentity(this.directoryIdentity)} ` +
          `actual=${formatIdentity(identityOf(handleStat))}`,
      );
    }

    // 路径复核用于发现配置路径被替换，不作为写操作的安全边界。
    assertDevSampleFilesDirectory(this.directory, this.database);
    let pathStat: fs.BigIntStats;
    try {
      pathStat = await fsp.lstat(this.directory, { bigint: true });
    } catch {
      throw new Error(`开发样例原件配置路径已不存在，拒绝继续初始化：${this.directory}`);
    }
    if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
      throw new Error(`开发样例原件配置路径已不是真实目录，拒绝继续初始化：${this.directory}`);
    }
    if (!sameIdentity(identityOf(pathStat), this.directoryIdentity)) {
      throw new Error(
        `开发样例原件配置路径已指向其他目录，拒绝继续初始化：${this.directory} ` +
          `claimed=${formatIdentity(this.directoryIdentity)} ` +
          `currentPath=${formatIdentity(identityOf(pathStat))}`,
      );
    }

    const marker = await readOwnerMarker(handle);
    if (marker === null) {
      throw new Error(`开发样例原件目录归属标记已丢失：${this.markerPath}`);
    }
    assertMarkerMatches(marker, this.markerPath, this.database, this.serverUuid);
    if (!sameIdentity(marker.identity, this.markerIdentity)) {
      throw new Error(`开发样例原件目录归属标记已被替换：${this.markerPath}`);
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

  private requireHandle(): FileHandle {
    if (this.handle === null) {
      throw new Error(`开发样例原件目录句柄已关闭，拒绝回退到路径写入：${this.directory}`);
    }
    return this.handle;
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
  /** 已核验的目录句柄归属；写入不再接受按路径重新解析目录。 */
  readonly ownership: DevSampleDirectoryOwnership;
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
  /** 测试注入点：暂存对象核对通过后、实际发布前；用于确定性地替换路径。 */
  readonly beforePublish?: () => Promise<void> | void;
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

/** 目录句柄绑定依赖 Linux 的 `/proc/self/fd`；不支持时直接拒绝，不回退绝对路径。 */
function assertDirectoryHandleSupport(label: string): void {
  if (process.platform !== 'linux') {
    throw new Error(`${label}必须绑定已核验的目录句柄；当前平台不支持，拒绝回退到绝对路径`);
  }
}

function assertObjectName(relativeName: string): void {
  if (
    relativeName.length === 0 ||
    relativeName === '.' ||
    relativeName === '..' ||
    relativeName.includes('/') ||
    relativeName.includes('\\') ||
    path.basename(relativeName) !== relativeName
  ) {
    throw new Error(`开发样例原件目录内对象名非法：${relativeName}`);
  }
}

function directoryFdPath(handle: FileHandle): string {
  return path.join(DIRECTORY_FD_ROOT, String(handle.fd));
}

function objectPathIn(handle: FileHandle, relativeName: string): string {
  assertObjectName(relativeName);
  return path.join(directoryFdPath(handle), relativeName);
}

/** 校验存储引用格式并解析为目录内绝对路径（仅用于报告/只读核对）。 */
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

function identityOf(stat: {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}): DevSampleFileIdentity {
  return { device: BigInt(stat.dev), inode: BigInt(stat.ino) };
}

function formatIdentity(identity: DevSampleFileIdentity): string {
  return `dev=${String(identity.device)},ino=${String(identity.inode)}`;
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

/**
 * 经目录句柄读取归属标记：打开、身份与内容都绑定同一文件对象。
 *
 * 只读打开带 `O_NONBLOCK`：FIFO 等特殊文件不会阻塞在 open，而是在同一句柄上
 * 检查文件类型后立即拒绝；`O_NOFOLLOW` 继续拒绝末段符号链接。
 */
async function readOwnerMarker(handle: FileHandle): Promise<OwnerMarkerRecord | null> {
  const markerPath = objectPathIn(handle, DEV_SAMPLE_DIRECTORY_MARKER);
  let file: FileHandle;
  try {
    file = await fsp.open(
      markerPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return null;
    }
    if (errorCode(error) === 'ELOOP') {
      throw new Error(`开发样例原件目录归属标记不得为符号链接：${markerPath}`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile()) {
      throw new Error(`开发样例原件目录归属标记必须是普通文件，不得为符号链接：${markerPath}`);
    }
    if (stat.size > BigInt(OWNER_MARKER_MAX_BYTES)) {
      throw new Error(`开发样例原件目录归属标记异常过大：${markerPath}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.readFile('utf8'));
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
    return {
      database: record.database,
      serverUuid: record.server_uuid,
      identity: identityOf(stat),
    };
  } finally {
    await file.close();
  }
}

/** 经目录句柄排他创建归属标记；已存在时由调用方复核。 */
async function createOwnerMarker(
  handle: FileHandle,
  database: string,
  serverUuid: string,
): Promise<void> {
  const file = await fsp.open(objectPathIn(handle, DEV_SAMPLE_DIRECTORY_MARKER), 'wx', 0o600);
  let writeError: unknown = null;
  try {
    await file.writeFile(
      Buffer.from(
        `${JSON.stringify({
          format_version: OWNER_FORMAT_VERSION,
          database,
          server_uuid: serverUuid,
        })}\n`,
        'utf8',
      ),
    );
    await file.sync();
  } catch (error) {
    writeError = error;
  }
  try {
    await file.close();
  } catch (closeError) {
    if (writeError === null) {
      writeError = closeError;
    }
  }
  if (writeError !== null) {
    throw writeError instanceof Error
      ? writeError
      : new Error(`写入开发样例原件目录归属标记失败：${messageOf(writeError)}`, {
          cause: writeError,
        });
  }
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

/** 打开目录前核对配置路径仍指向同一目录，防止守卫与打开之间被替换。 */
function assertPathMatchesDirectory(
  directory: string,
  directoryIdentity: DevSampleFileIdentity,
): void {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(directory, { bigint: true });
  } catch {
    throw new Error(`开发样例原件目录在检查与打开之间已不存在：${directory}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`开发样例原件目录在检查与打开之间已不是真实目录：${directory}`);
  }
  if (!sameIdentity(identityOf(stat), directoryIdentity)) {
    throw new Error(
      `开发样例原件目录在检查与打开之间被替换：${directory} ` +
        `checked=${formatIdentity(directoryIdentity)} ` +
        `currentPath=${formatIdentity(identityOf(stat))}`,
    );
  }
}

/**
 * 打开目录后核对句柄真实路径仍等于配置路径。
 *
 * `O_NOFOLLOW` 只保护路径末段；若检查与打开之间上级目录被换成符号链接，
 * `lstat(directory)` 也会跟随中间链接，身份比较无法发现。这里以 `/proc/self/fd`
 * 反查已打开句柄的真实路径，确保归属标记与所有后续写入落在配置路径本身。
 */
function assertHandleRealPath(handle: FileHandle, directory: string): void {
  let realPath: string;
  try {
    realPath = fs.realpathSync(directoryFdPath(handle));
  } catch {
    throw new Error(`无法解析开发样例原件目录句柄的真实路径：${directory}`);
  }
  if (realPath !== directory) {
    throw new Error(
      `开发样例原件目录句柄指向的路径与配置不一致，拒绝在未认领目录写入：` +
        `configured=${directory} handle=${realPath}`,
    );
  }
}

/**
 * 首次认领目标库专属原件目录；已认领时只核对实例 UUID 与精确库名。
 *
 * 认领与后续写入共用同一个已打开目录句柄：目录身份、归属标记、暂存对象与最终发布
 * 都经该句柄核对/创建，配置路径之后被替换也不会把写入带到未认领目录。
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
  assertDirectoryHandleSupport('开发样例原件目录认领');
  const resolved = path.resolve(directory);
  const markerPath = path.join(resolved, DEV_SAMPLE_DIRECTORY_MARKER);

  let handle: FileHandle | null = null;
  let claimed = false;
  try {
    handle = await fsp.open(
      resolved,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const directoryStat = await handle.stat({ bigint: true });
    if (!directoryStat.isDirectory()) {
      throw new Error(`开发样例原件目录句柄不是目录：${resolved}`);
    }
    const directoryIdentity = identityOf(directoryStat);
    assertPathMatchesDirectory(resolved, directoryIdentity);
    assertHandleRealPath(handle, resolved);

    const existing = await readOwnerMarker(handle);
    if (existing !== null) {
      assertMarkerMatches(existing, markerPath, database, expectedUuid);
      claimed = true;
      return new DevSampleDirectoryHandle(
        resolved,
        database,
        expectedUuid,
        markerPath,
        existing.identity,
        directoryIdentity,
        handle,
      );
    }

    const entries = await fsp.readdir(directoryFdPath(handle));
    if (entries.length > 0) {
      throw new Error(`开发样例原件目录非空且无可信归属标记，拒绝认领并保留现场：${resolved}`);
    }

    try {
      await createOwnerMarker(handle, database, expectedUuid);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
      const raced = await readOwnerMarker(handle);
      if (raced === null) {
        throw error;
      }
      assertMarkerMatches(raced, markerPath, database, expectedUuid);
      claimed = true;
      return new DevSampleDirectoryHandle(
        resolved,
        database,
        expectedUuid,
        markerPath,
        raced.identity,
        directoryIdentity,
        handle,
      );
    }

    const marker = await readOwnerMarker(handle);
    if (marker === null) {
      throw new Error(`开发样例原件目录归属标记写入后不可见：${markerPath}`);
    }
    assertMarkerMatches(marker, markerPath, database, expectedUuid);
    claimed = true;
    return new DevSampleDirectoryHandle(
      resolved,
      database,
      expectedUuid,
      markerPath,
      marker.identity,
      directoryIdentity,
      handle,
    );
  } finally {
    if (!claimed && handle !== null) {
      try {
        await handle.close();
      } catch {
        // 认领失败时目录句柄关闭失败不覆盖主错误；句柄随进程退出释放。
      }
    }
  }
}

/**
 * 写入一份样例原件：私有暂存 → 回读校验 → 不覆盖发布。
 *
 * 暂存创建与发布都经已核验目录句柄完成，配置路径在写入期间被替换也不会写到未认领目录。
 * 最终路径不会出现半截文件：写入只发生在本轮排他创建的暂存对象上，字节数与哈希
 * 校验通过后才以 hard link（不覆盖）发布。发布后再次复核配置路径仍指向同一目录；
 * 变化时中止并保留已发布文件与目录身份诊断。EEXIST 时不认领、不覆盖、不删除既有文件。
 * 取得句柄后立即登记；失败时若已登记，句柄保留到事务收尾决定，由调用方保留并关闭。
 */
export async function writeDevSampleFile(
  directory: string,
  spec: DevSampleFileSpec,
  options: DevSampleFileWriteOptions,
): Promise<DevSampleFileWriteResult> {
  assertDirectoryHandleSupport('开发样例原件写入');
  const ownership = options.ownership;
  const baseDir = path.resolve(directory);
  if (path.resolve(ownership.directory) !== baseDir) {
    throw new Error(
      `开发样例原件写入目录与已认领目录不一致：配置 ${baseDir}，已认领 ${ownership.directory}`,
    );
  }
  const storageReference =
    options.storageReference ?? `${randomBytes(16).toString('hex')}.${DEV_SAMPLE_FILE_EXTENSION}`;
  const target = resolveSampleFile(baseDir, storageReference);
  const stagingName = resolveStagingName();
  const stagingPath = path.join(baseDir, stagingName);

  // 认领后、暂存创建前复核：配置路径一旦变化，不产生任何新目录项。
  await ownership.assertPathBinding();
  await assertTargetAbsent(ownership, storageReference, target);

  let handle: FileHandle | null = null;
  let claim: DevSampleFileClaimHandle | null = null;

  try {
    handle = await ownership.openObject(stagingName, 'wx+', 0o600);
    const stat = await (options.readIdentity ?? ((file: FileHandle) => file.stat()))(handle);
    if (!stat.isFile()) {
      throw new Error(`开发样例原件暂存对象不是普通文件：${stagingPath}`);
    }
    claim = new DevSampleFileClaimHandle(
      storageReference,
      stagingPath,
      target,
      identityOf(stat),
      ownership,
      handle,
    );
    options.onClaim?.(claim);

    const writeContent =
      options.writeContent ?? ((file: FileHandle, content: Buffer) => file.writeFile(content));
    await writeContent(handle, spec.content);
    await handle.sync();
    const written = await readHandleContent(handle, spec.byteSize);
    if (written.byteLength !== spec.byteSize || sha256Of(written) !== spec.sha256) {
      throw new Error(`开发样例原件写入后核对失败：${spec.originalFilename}`);
    }

    const stagingStat = await ownership.statObject(stagingName);
    const handleStat = await handle.stat({ bigint: true });
    if (
      stagingStat === null ||
      !stagingStat.isFile() ||
      !sameIdentity(identityOf(stagingStat), identityOf(handleStat))
    ) {
      throw new Error(`开发样例原件暂存路径已被替换，拒绝发布：${stagingPath}`);
    }

    await options.beforePublish?.();
    try {
      await linkVerifiedHandle(handle, ownership, storageReference);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        throw annotateError(error, [`最终路径已存在，未认领、未覆盖、未删除既有文件：${target}`]);
      }
      throw error;
    }
    claim.markPublished();

    // 发布同样经目录句柄完成；这里再核对最终目录项确实指向已校验源对象。
    const publishedStat = await ownership.statObject(storageReference);
    if (
      publishedStat === null ||
      !publishedStat.isFile() ||
      !sameIdentity(identityOf(publishedStat), claim.identity)
    ) {
      throw new Error(`开发样例原件发布后的最终目录项与已校验源不一致，拒绝登记引用：${target}`);
    }

    // 发布后、调用方写入资料引用前复核配置路径；变化时中止初始化并保留诊断。
    await ownership.assertPathBinding();
    // 共享原件目录没有可证的独占目录项边界：暂存路径在核对后仍可能被替换，
    // 因此不自动 unlink 暂存链接。成功发布后的暂存硬链接按安全策略保留并报告。
    return { storageReference, claim };
  } catch (error) {
    const notes: string[] = [];
    if (claim === null) {
      const stagingCreated = handle !== null;
      if (handle !== null) {
        try {
          await closeHandle(handle);
          handle = null;
        } catch (closeFailure) {
          notes.push(`关闭暂存句柄失败：${messageOf(closeFailure)}`);
        }
      }
      notes.push(
        stagingCreated
          ? `未登记本轮原件归属，已保留暂存现场：${stagingPath}`
          : `未创建暂存对象，本轮未登记原件归属：${stagingPath}`,
      );
      throw annotateError(error, notes);
    }

    const anchor = claim.published ? claim.finalPath : claim.stagingPath;
    notes.push(
      claim.published
        ? `最终路径已发布，事务收尾不得按路径自动删除：${anchor}`
        : `暂存对象已登记，事务收尾不得按路径自动删除：${anchor}`,
    );
    if (claim.published) {
      notes.push(
        `已发布文件身份 ${formatIdentity(claim.identity)}；` +
          `目录身份 ${formatIdentity(ownership.directoryIdentity)}；` +
          `若配置路径已变化，须由维护者按文件与目录身份人工核对处置`,
      );
    }
    throw annotateError(error, notes);
  }
}

/**
 * 把已校验的源文件句柄链接到已核验目录句柄中的白名单相对名。
 *
 * 源与目标都不经过配置路径重新解析：源为打开的暂存文件，目标为打开的目录句柄。
 * 子进程 fd 编号全部选在两个父句柄 fd 之后，避免 dup2 顺序覆盖任一输入句柄。
 */
async function linkVerifiedHandle(
  source: FileHandle,
  ownership: DevSampleDirectoryOwnership,
  storageReference: string,
): Promise<void> {
  assertDirectoryHandleSupport('开发样例原件发布');
  assertObjectName(storageReference);
  const sourceFd = source.fd;
  const directoryFd = ownership.directoryFd;
  const sourceChildFd = Math.max(sourceFd, directoryFd) + 1;
  const directoryChildFd = sourceChildFd + 1;
  const stdio: Array<'ignore' | number> = ['ignore', 'ignore', 'ignore'];
  while (stdio.length < directoryChildFd) {
    stdio.push('ignore');
  }
  stdio[sourceChildFd] = sourceFd;
  stdio[directoryChildFd] = directoryFd;

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        '/usr/bin/ln',
        [
          '-L',
          '-T',
          '--',
          `${DIRECTORY_FD_ROOT}/${String(sourceChildFd)}`,
          `${DIRECTORY_FD_ROOT}/${String(directoryChildFd)}/${storageReference}`,
        ],
        { stdio },
      );
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0) resolve();
        else
          reject(new Error(`开发样例原件句柄发布失败（${code ?? signal}）：${storageReference}`));
      });
    });
  } catch (error) {
    await assertTargetAbsent(
      ownership,
      storageReference,
      path.join(ownership.directory, storageReference),
    );
    throw error;
  }
}

function resolveStagingName(): string {
  const name = `.dev-sample-staging-${randomBytes(16).toString('hex')}`;
  if (!STAGING_OBJECT_PATTERN.test(name)) {
    throw new Error(`开发样例暂存对象命名非法：${name}`);
  }
  return name;
}

async function assertTargetAbsent(
  ownership: DevSampleDirectoryOwnership,
  storageReference: string,
  target: string,
): Promise<void> {
  if ((await ownership.statObject(storageReference)) === null) {
    return;
  }
  const error = new Error(`开发样例原件最终路径已存在（EEXIST），拒绝认领、覆盖或删除：${target}`);
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
 * - 目录句柄内暂存与最终目录项均已不存在：DELETED（本轮无需处置）；
 * - 仍有任一项：一律 RETAINED，由事务输出路径、终局与原因，禁止自动清理。
 *
 * 存在性判断同样绑定已认领目录句柄，不按配置路径重新解析：配置路径在发布后
 * 被替换时，路径文本可能指向未认领目录，按路径判断会误报“无残留”。
 * 正常回滚因此不再保证磁盘零残留；若必须自动清零，需要另行设计可证明的独占边界。
 */
export async function deleteDevSampleFile(
  claim: DevSampleFileClaim,
): Promise<DevSampleFileRemoval> {
  const relativeNames = claim.published
    ? [claim.storageReference, path.basename(claim.stagingPath)]
    : [path.basename(claim.stagingPath)];
  for (const relativeName of relativeNames) {
    assertObjectName(relativeName);
    if ((await claim.ownership.statObject(relativeName)) !== null) {
      return 'RETAINED';
    }
  }
  return 'DELETED';
}

/**
 * 只读核对已认领目录内的既有文件。
 *
 * 核验绑定已认领目录句柄：先复核配置路径仍指向该目录、归属标记未被替换，
 * 再经目录句柄打开白名单相对名。只读打开带 `O_NONBLOCK`，FIFO 等特殊文件不会
 * 阻塞在 open；`O_NOFOLLOW` 不跟随符号链接。打开后只接受普通文件，并在同一个
 * 文件句柄上核对字节数与 SHA-256，所有分支都关闭句柄。
 * 只有目录绑定与归属标记都成立、且目录项确实不存在时才返回 MISSING；
 * 路径变化、归属标记异常、符号链接与非普通文件一律拒绝，不能当作缺文件继续。
 */
export async function verifyDevSampleFile(
  ownership: DevSampleDirectoryOwnership,
  storageReference: string,
  spec: DevSampleFileSpec,
): Promise<DevSampleFileState> {
  assertObjectName(storageReference);
  if (!STORAGE_REFERENCE_PATTERN.test(storageReference)) {
    throw new Error(`开发样例原件存储引用格式非法：${storageReference}`);
  }
  await ownership.assertPathBinding();

  let handle: FileHandle;
  try {
    handle = await ownership.openObject(
      storageReference,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return 'MISSING';
    }
    if (errorCode(error) === 'ELOOP') {
      throw new Error(`开发样例原件不得为符号链接，拒绝核验：${storageReference}`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) {
      throw new Error(`开发样例原件必须是普通文件，不得为符号链接：${storageReference}`);
    }
    if (stat.size !== BigInt(spec.byteSize)) {
      return 'MISMATCH';
    }
    const content = Buffer.alloc(spec.byteSize);
    let offset = 0;
    while (offset < spec.byteSize) {
      const { bytesRead } = await handle.read(content, offset, spec.byteSize - offset, offset);
      if (bytesRead === 0) {
        throw new Error(`开发样例原件回读提前结束：${storageReference}`);
      }
      offset += bytesRead;
    }
    return sha256Of(content) === spec.sha256 ? 'VERIFIED' : 'MISMATCH';
  } finally {
    await handle.close();
  }
}

/**
 * 提交前核对：已认领目录、归属标记与本轮已发布的正式目录项仍指向登记对象。
 *
 * 在初始化回调完成后、发出 COMMIT 之前调用。任一不符即抛出含具体路径的错误，
 * 由调用方走既有回滚与原件保留策略，不发出 COMMIT。
 */
export async function assertDevSamplePublicationStable(
  ownership: DevSampleDirectoryOwnership,
  claims: ReadonlyArray<DevSampleFileClaim>,
): Promise<void> {
  await ownership.assertPathBinding();
  for (const claim of claims) {
    if (!claim.published) {
      continue;
    }
    const stat = await ownership.statObject(claim.storageReference);
    if (stat === null) {
      throw new Error(`开发样例原件正式目录项已不存在，拒绝提交初始化：${claim.finalPath}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`开发样例原件正式目录项已不是普通文件，拒绝提交初始化：${claim.finalPath}`);
    }
    if (!sameIdentity(identityOf(stat), claim.identity)) {
      throw new Error(
        `开发样例原件正式目录项已被替换，拒绝提交初始化：${claim.finalPath} ` +
          `registered=${formatIdentity(claim.identity)} ` +
          `current=${formatIdentity(identityOf(stat))}`,
      );
    }
  }
}

function annotateError(error: unknown, notes: ReadonlyArray<string>): Error {
  if (notes.length === 0) {
    return error instanceof Error ? error : new Error(messageOf(error), { cause: error });
  }
  if (error instanceof Error) {
    const annotated = error as Error & { cleanupErrors?: ReadonlyArray<string> };
    annotated.cleanupErrors = [...(annotated.cleanupErrors ?? []), ...notes];
    return annotated;
  }
  const wrapped = new Error(messageOf(error), { cause: error });
  (wrapped as Error & { cleanupErrors?: ReadonlyArray<string> }).cleanupErrors = notes;
  return wrapped;
}
