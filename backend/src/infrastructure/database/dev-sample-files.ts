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
 * - 只有成功取得 `wx` 句柄并记录对象身份（dev+ino）的原件才登记为本轮所有；
 * - 回收前必须同时确认目录归属与目标对象身份，任一不明都保留现场并报告路径。
 */
export const DEV_SAMPLE_FILE_MIME_TYPE = 'text/plain';
export const DEV_SAMPLE_FILE_EXTENSION = 'txt';
export const DEV_SAMPLE_FILE_MAX_BYTES = 64 * 1024;
export const DEV_SAMPLE_DIRECTORY_MARKER = '.lithography-dev-sample-owner.json';

const STORAGE_REFERENCE_PATTERN = /^[0-9a-f]{32}\.txt$/;
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
  readonly filePath: string;
  readonly identity: DevSampleFileIdentity;
  readonly ownership: DevSampleDirectoryOwnership;
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
  readonly readIdentity?: (
    handle: FileHandle,
  ) => Promise<{
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
 * 写入一份样例原件并回读核对字节数与哈希。
 *
 * 使用 `wx` 排他创建，已存在的文件既不覆盖也不删除；只有成功取得句柄并记录
 * 对象身份后才登记本轮归属。写入/核对失败时，仅在目录归属与对象身份都可确认
 * 时回收；否则保留现场并在错误上附加路径，交由调用方报告。
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

  let handle: FileHandle | null = null;
  let claim: DevSampleFileClaim | null = null;
  let mainError: unknown = null;
  let closeError: unknown = null;
  let result: DevSampleFileWriteResult | null = null;

  try {
    handle = await fsp.open(target, 'wx');
    const stat = await (options.readIdentity ?? ((file: FileHandle) => file.stat()))(handle);
    if (!stat.isFile()) {
      throw new Error(`开发样例原件目标不是普通文件：${target}`);
    }
    if (ownership !== null) {
      claim = {
        storageReference,
        filePath: target,
        identity: identityOf(stat),
        ownership,
      };
      options.onClaim?.(claim);
    }
    const writeContent =
      options.writeContent ?? ((file: FileHandle, content: Buffer) => file.writeFile(content));
    await writeContent(handle, spec.content);
    const written = await fsp.readFile(target);
    if (written.byteLength !== spec.byteSize || sha256Of(written) !== spec.sha256) {
      throw new Error(`开发样例原件写入后核对失败：${spec.originalFilename}`);
    }
    result = { storageReference, claim };
  } catch (error) {
    mainError = error;
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch (error) {
        closeError = error;
      }
    }
  }

  if (mainError === null && closeError !== null) {
    mainError = closeError;
  }
  if (mainError !== null) {
    const notes: string[] = [];
    if (closeError !== null && closeError !== mainError) {
      notes.push(`关闭原件句柄失败：${messageOf(closeError)}`);
    }
    if (claim !== null) {
      try {
        const removal = await deleteDevSampleFile(claim);
        if (removal === 'RETAINED') {
          notes.push(`原件未能安全回收，已保留现场：${claim.filePath}`);
        }
      } catch (error) {
        notes.push(`原件补偿清理失败，已保留现场 ${claim.filePath}：${messageOf(error)}`);
      }
    } else {
      notes.push(`未登记本轮原件归属，已保留现场：${target}`);
    }
    throw annotateError(mainError, notes);
  }

  return result as DevSampleFileWriteResult;
}

/**
 * 精确回收本轮原件。
 *
 * 必须同时满足：目标仍是登记的对象身份、目录归属标记未被替换。
 * 任一条件不满足都返回 RETAINED，由调用方保留现场并报告路径。
 */
export async function deleteDevSampleFile(
  claim: DevSampleFileClaim,
): Promise<DevSampleFileRemoval> {
  const target = resolveSampleFile(claim.ownership.directory, claim.storageReference);
  if (target !== claim.filePath) {
    throw new Error(`开发样例原件回收路径与登记不一致：${claim.filePath}`);
  }
  let stat: fs.Stats;
  try {
    stat = await fsp.lstat(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return 'DELETED';
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return 'RETAINED';
  }
  if (!sameIdentity(identityOf(stat), claim.identity)) {
    return 'RETAINED';
  }
  try {
    await assertOwnershipStillCurrent(claim.ownership);
  } catch {
    return 'RETAINED';
  }
  try {
    await fsp.unlink(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return 'DELETED';
    }
    throw error;
  }
  try {
    await fsp.lstat(target);
    return 'RETAINED';
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return 'DELETED';
    }
    throw error;
  }
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
