// src/infrastructure/cloud/http-local-backup-uploader.ts

/**
 * 备份包上云的**生产适配实现**（任务 09 S3.1；第 10 项 D3／D5／D7／D9 修订）。
 *
 * 协议（与云端约定一致；云端未就绪时本实现不会被注册）：
 * - `POST {baseUrl}/backup-packages`，`multipart/form-data`：
 *   - 字段 `backupId` / `organizationId` / `installationId` / `manifestChecksum` / `byteSize`；
 *   - 部件 `manifest`（清单原文）、`payload`（加密载荷字节）、`files/<相对路径>`（业务原件字节）；
 * - 成功响应（2xx）必须同时给出**云端对象引用**与**完整回执**：
 *   `{ "cloudReference": "...", "receipt": "..." }`；缺任一字段按形态非法失败关闭。
 *
 * 纪律：
 * - 只在本机包目录内取字节，不跟随符号链接、不读目录外文件；
 * - **只上传清单登记的内容**：清单是包的权威内容清单，包内多余文件（生成侧复制失败
 *   会留下半截文件）一律不发；
 * - **本机侧失败与云端侧失败分开归类**：本机包读不到、清单与字节对不上、超过大小
 *   上限，都不得报成"云端不可达"（排障方向会被带偏）；
 * - 失败一律返回**受控原因码**，不回显自由文本、本机绝对路径或凭据片段；
 * - **不伪造成功**：云端未返回完整回执即按失败处理（清理因此保持零清理）。
 */

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import * as nodePath from 'node:path';

import { Injectable } from '@nestjs/common';

import {
  CLOUD_UPLOAD_FAILURE_CODES,
  decideCloudUploadPackageConsistency,
  decideCloudUploadSizeLimit,
  decideCloudUploadSuccess,
  type CloudUploadFileFact,
} from '@core/local-runtime/policy/local-backup-cloud-upload.policy';
import { parseBackupManifest } from '@core/local-runtime/policy/protected-backup.policy';
import {
  LOCAL_BACKUP_UPLOADER,
  type LocalBackupUploadRequest,
  type LocalBackupUploadResult,
  type LocalBackupUploader,
} from '@usecases/common/ports/local-backup-upload.contract';

import { HttpLocalBackupCloudClient } from './http-local-backup-cloud.client';

const MANIFEST_FILE = 'manifest.json';
const PAYLOAD_FILE = 'payload.enc';
const FILES_DIR = 'files';

/** 清单里原件部件的相对路径前缀 */
const ORIGINALS_PREFIX = `${FILES_DIR}/`;

/** 本机包侧的受控失败（与"云端侧失败"分开归类） */
/**
 * 本机包**结构性失败**（本机事实问题，与云端如何响应无关）。
 *
 * 该错误在 `upload()` 内部被捕获并转成**受控结果码**（`failed(code)`），
 * 因此不会逃逸到调用方；类只在本模块内用于区分包级失败与其它异常。
 */
class CloudUploadPackageError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CloudUploadPackageError';
  }
}

/** 已核对完毕的上传内容（本机侧全部核对通过） */
type PreparedPackage = {
  /** 清单原文字节 */
  manifest: Buffer;
  /** 加密载荷字节 */
  payload: Buffer;
  /** 原件字节（逐项与清单一致） */
  originals: Array<{ relativePath: string; bytes: Buffer }>;
};

@Injectable()
export class HttpLocalBackupUploader implements LocalBackupUploader {
  constructor(private readonly client: HttpLocalBackupCloudClient) {}

  async upload(request: LocalBackupUploadRequest): Promise<LocalBackupUploadResult> {
    if (!this.client.configured) {
      return failed(CLOUD_UPLOAD_FAILURE_CODES.CLOUD_NOT_CONFIGURED);
    }

    // ── 第一段：本机包准备。
    // 本机侧失败**不得**报成"云端不可达"（D9）：把本机事实问题说成远端故障，
    // 会把排障方向直接带偏（云端明明好好的）。
    let prepared: PreparedPackage;
    try {
      prepared = await this.preparePackage(request);
    } catch (error) {
      const code =
        error instanceof CloudUploadPackageError
          ? error.code
          : CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_UNREADABLE;
      return failed(code);
    }

    // ── 第二段：真实 multipart 上传（网络／云端侧失败由客户端统一归类）
    const result = await this.client.call(
      async () => {
        const response = await this.client.http.post(
          this.client.buildUrl('/backup-packages'),
          this.buildForm(request, prepared),
          { headers: this.client.headers() },
        );
        return { status: response.status, data: response.data as unknown };
      },
      (data) => parseUploadReceipt(data),
    );

    if (!result.ok) {
      return failed(result.code);
    }

    // 成功判定与"手动清理授权"**同口径**（D7）：此前上传成功只要求"回执非空"，
    // 而清理授权要求"回执可解析为 JSON 且带成功语义"——两处口径分裂会让
    // "资产显示已上云"与"手动清理恒为零"同时成立。
    const success = decideCloudUploadSuccess({
      cloudReference: result.value.cloudReference,
      receipt: result.value.receipt,
    });
    if (!success.succeeded) {
      return failed(success.code);
    }

    return {
      status: 'SUCCEEDED',
      cloudReference: result.value.cloudReference,
      receipt: result.value.receipt,
    };
  }

  /**
   * 准备本机包：读清单 → 核摘要 → 定上限 → 逐项核对字节。
   *
   * 顺序刻意如此：
   * 1. **先读清单**：清单是权威内容清单；"清单说有、包里没有"必须被发现（D5）；
   * 2. **再判大小**：在读取载荷与原件**字节之前**判上限（D3）——
   *    "读完才发现超限"时内存峰值已经付出去了，上限就失去了意义；
   * 3. **最后逐项核对**：清单登记的每个文件都要在包内存在且字节数与摘要一致。
   */
  private async preparePackage(request: LocalBackupUploadRequest): Promise<PreparedPackage> {
    const paths = resolvePackagePaths(request.packagePath);
    const manifest = await this.readManifest(paths.manifestPath, request.manifestChecksum);
    const facts = this.readManifestFacts(manifest);
    const declaredOriginals = this.requireSupportedFiles(facts);
    this.assertWithinSizeLimit(facts);
    const payload = await readFileOrFail(paths.payloadPath);
    const originals = await this.readOriginalBytes(paths.filesRoot, declaredOriginals);

    const consistency = decideCloudUploadPackageConsistency({
      declared: facts,
      actual: [
        {
          relativePath: PAYLOAD_FILE,
          byteSize: payload.byteLength,
          sha256: sha256Of(payload),
        },
        ...originals.map((item) => ({
          relativePath: item.relativePath,
          byteSize: item.bytes.byteLength,
          sha256: sha256Of(item.bytes),
        })),
      ],
    });
    if (!consistency.consistent) {
      throw new CloudUploadPackageError(consistency.code);
    }

    return { manifest, payload, originals };
  }

  /** 读清单：必须可读、大小在上限内、摘要与资产行登记值一致 */
  private async readManifest(manifestPath: string, expectedChecksum: string): Promise<Buffer> {
    const manifestStat = await statOrNull(manifestPath);
    if (manifestStat === null || !manifestStat.isFile()) {
      throw new CloudUploadPackageError(CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_UNREADABLE);
    }
    if (manifestStat.size > this.client.config.maxUploadFileBytes) {
      throw new CloudUploadPackageError(CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_TOO_LARGE);
    }
    const manifest = await readFileOrFail(manifestPath);
    // 清单摘要必须与资产行登记值一致：本机包被换过／被改过 ⇒ 不上传
    if (
      /^[0-9a-f]{64}$/i.test(expectedChecksum) &&
      sha256Of(manifest) !== expectedChecksum.toLowerCase()
    ) {
      throw new CloudUploadPackageError(CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_UNREADABLE);
    }
    return manifest;
  }

  /** 解析清单为文件事实（不可解析 ⇒ 本机包不可读） */
  private readManifestFacts(manifest: Buffer): CloudUploadFileFact[] {
    try {
      return toManifestFileFacts(parseBackupManifest(JSON.parse(manifest.toString('utf8'))));
    } catch {
      throw new CloudUploadPackageError(CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_UNREADABLE);
    }
  }

  /** 只接受协议覆盖的文件（载荷 ＋ 原件），并返回清单登记的原件 */
  private requireSupportedFiles(facts: CloudUploadFileFact[]): CloudUploadFileFact[] {
    const hasPayload = facts.some((file) => file.relativePath === PAYLOAD_FILE);
    const originals = facts.filter((file) => file.relativePath.startsWith(ORIGINALS_PREFIX));
    const unsupported = facts.filter(
      (file) =>
        file.relativePath !== PAYLOAD_FILE && !file.relativePath.startsWith(ORIGINALS_PREFIX),
    );
    if (!hasPayload || unsupported.length > 0) {
      throw new CloudUploadPackageError(CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_INCOMPLETE);
    }
    return originals;
  }

  /** 大小上限：在读取载荷与原件字节之前判定（D3） */
  private assertWithinSizeLimit(facts: CloudUploadFileFact[]): void {
    const verdict = decideCloudUploadSizeLimit({
      files: facts.map((file) => ({ relativePath: file.relativePath, byteSize: file.byteSize })),
      maxFileBytes: this.client.config.maxUploadFileBytes,
      maxPackageBytes: this.client.config.maxUploadPackageBytes,
    });
    if (!verdict.allowed) {
      throw new CloudUploadPackageError(verdict.code);
    }
  }

  /** 原件字节：清单登记了几件，就必须读到几件（D5）；符号链接不跟随 */
  private async readOriginalBytes(
    filesRoot: string,
    declared: CloudUploadFileFact[],
  ): Promise<Array<{ relativePath: string; bytes: Buffer }>> {
    if (declared.length === 0) {
      return [];
    }
    const entries = await readdirOrNull(filesRoot);
    if (entries === null) {
      // 原件目录读不到 ⇒ 不得静默成"零原件但上传成功"
      throw new CloudUploadPackageError(CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_UNREADABLE);
    }
    const originals: Array<{ relativePath: string; bytes: Buffer }> = [];
    for (const item of declared) {
      const name = item.relativePath.slice(ORIGINALS_PREFIX.length);
      const absolute = nodePath.join(filesRoot, name);
      // 用 `lstat`：**不跟随符号链接**（跟随会把包外的文件读进来并上传）
      const entryStat = await lstatOrNull(absolute);
      if (entryStat === null || !entryStat.isFile()) {
        continue;
      }
      originals.push({ relativePath: item.relativePath, bytes: await readFileOrFail(absolute) });
    }
    return originals;
  }

  /** 组装 multipart 表单：字段 ＋ 清单 ＋ 载荷 ＋ 原件（只发清单登记的内容） */
  private buildForm(request: LocalBackupUploadRequest, prepared: PreparedPackage): FormData {
    const form = new FormData();
    form.append('backupId', request.backupId);
    form.append('organizationId', String(request.organizationId));
    form.append('installationId', request.installationId);
    form.append('manifestChecksum', request.manifestChecksum);
    form.append('byteSize', String(request.byteSize));
    form.append(
      'manifest',
      new Blob([new Uint8Array(prepared.manifest)], { type: 'application/json' }),
      MANIFEST_FILE,
    );
    form.append('payload', new Blob([new Uint8Array(prepared.payload)]), PAYLOAD_FILE);
    for (const original of prepared.originals) {
      const name = original.relativePath.slice(ORIGINALS_PREFIX.length);
      form.append(original.relativePath, new Blob([new Uint8Array(original.bytes)]), name);
    }
    return form;
  }
}

/** 包内路径（只在本机包目录内取字节） */
function resolvePackagePaths(packagePath: string): {
  manifestPath: string;
  payloadPath: string;
  filesRoot: string;
} {
  const packageRoot = nodePath.resolve(packagePath);
  return {
    manifestPath: nodePath.join(packageRoot, MANIFEST_FILE),
    payloadPath: nodePath.join(packageRoot, PAYLOAD_FILE),
    filesRoot: nodePath.join(packageRoot, FILES_DIR),
  };
}

/** 受控失败结果 */
function failed(code: string): LocalBackupUploadResult {
  return { status: 'FAILED', reason: code, code };
}

/** 清单里的文件事实（包内相对路径 ＋ 字节数 ＋ 登记摘要） */
function toManifestFileFacts(manifest: {
  files: Array<{ relative_path: string; sha256: string; byte_size: number }>;
}): CloudUploadFileFact[] {
  return manifest.files.map((file) => ({
    relativePath: file.relative_path,
    byteSize: file.byte_size,
    sha256: file.sha256.toLowerCase(),
  }));
}

/**
 * 字节 → SHA-256（十六进制小写）。
 *
 * 与 core 的 `backupManifestChecksum`（清单**原文**的摘要）**同口径**：
 * 本函数按**文件字节**计算，`backupManifestChecksum` 按 utf8 文本计算，
 * 对 utf8 清单两者取值相同（清单由 `JSON.stringify(..., null, 2)` 写盘，必为 utf8）。
 * 这里保留字节级实现，是因为比对对象就是磁盘上的文件字节——
 * 若改成按文本计算，遇到非 utf8 字节会与资产行登记的字节摘要对不上。
 */
function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

async function readdirOrNull(path: string): Promise<string[] | null> {
  try {
    return await readdir(path);
  } catch {
    return null;
  }
}

async function readFileOrFail(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    throw new CloudUploadPackageError(CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_UNREADABLE);
  }
}

/** 解析上云回执：缺引用或缺回执一律按形态非法处理 */
function parseUploadReceipt(data: unknown): { cloudReference: string; receipt: string } | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const candidate = data as { cloudReference?: unknown; receipt?: unknown };
  if (typeof candidate.cloudReference !== 'string' || candidate.cloudReference.length === 0) {
    return null;
  }
  if (typeof candidate.receipt !== 'string' || candidate.receipt.length === 0) {
    return null;
  }
  return { cloudReference: candidate.cloudReference, receipt: candidate.receipt };
}

/** 端口令牌别名（便于 DI 引用） */
export const LOCAL_BACKUP_UPLOADER_TOKEN = LOCAL_BACKUP_UPLOADER;
