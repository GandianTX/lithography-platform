// src/infrastructure/cloud/http-local-backup-uploader.ts

/**
 * 备份包上云的**生产适配实现**（任务 09 S3.1）。
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
 * - 失败一律返回**受控原因码**，不回显自由文本、本机绝对路径或凭据片段；
 * - **不伪造成功**：云端未返回完整回执即按失败处理（清理因此保持零清理）。
 */

import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import * as nodePath from 'node:path';

import { Injectable } from '@nestjs/common';

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

@Injectable()
export class HttpLocalBackupUploader implements LocalBackupUploader {
  constructor(private readonly client: HttpLocalBackupCloudClient) {}

  async upload(request: LocalBackupUploadRequest): Promise<LocalBackupUploadResult> {
    if (!this.client.configured) {
      return { status: 'FAILED', reason: 'CLOUD_NOT_CONFIGURED', code: 'CLOUD_NOT_CONFIGURED' };
    }

    const packageRoot = nodePath.resolve(request.packagePath);
    const manifestPath = nodePath.join(packageRoot, MANIFEST_FILE);
    const payloadPath = nodePath.join(packageRoot, PAYLOAD_FILE);
    const filesRoot = nodePath.join(packageRoot, FILES_DIR);

    try {
      const manifestStat = await stat(manifestPath);
      if (!manifestStat.isFile()) {
        return {
          status: 'FAILED',
          reason: 'CLOUD_INVALID_RESPONSE',
          code: 'CLOUD_INVALID_RESPONSE',
        };
      }
      const manifest = await readFile(manifestPath);
      const payload = await readFile(payloadPath);
      const originalParts = await this.collectOriginalParts(filesRoot);

      const form = new FormData();
      form.append('backupId', request.backupId);
      form.append('organizationId', String(request.organizationId));
      form.append('installationId', request.installationId);
      form.append('manifestChecksum', request.manifestChecksum);
      form.append('byteSize', String(request.byteSize));
      form.append(
        'manifest',
        new Blob([new Uint8Array(manifest)], { type: 'application/json' }),
        MANIFEST_FILE,
      );
      form.append('payload', new Blob([new Uint8Array(payload)]), PAYLOAD_FILE);
      for (const part of originalParts) {
        form.append(
          `files/${part.relativePath}`,
          new Blob([new Uint8Array(part.bytes)]),
          part.relativePath,
        );
      }

      const result = await this.client.call(
        async () => {
          const response = await this.client.http.post(
            this.client.buildUrl('/backup-packages'),
            form,
            {
              headers: this.client.headers(),
              timeout: undefined,
            },
          );
          return { status: response.status, data: response.data as unknown };
        },
        (data) => parseUploadReceipt(data),
      );

      if (!result.ok) {
        return { status: 'FAILED', reason: result.code, code: result.code };
      }
      return {
        status: 'SUCCEEDED',
        cloudReference: result.value.cloudReference,
        receipt: result.value.receipt,
      };
    } catch {
      // 读包失败同样按失败关闭：不伪造成功、不回显本机路径
      return { status: 'FAILED', reason: 'CLOUD_UNREACHABLE', code: 'CLOUD_UNREACHABLE' };
    }
  }

  /** 收集业务原件字节（只取 files/ 下的普通文件，不跟随符号链接） */
  private async collectOriginalParts(
    filesRoot: string,
  ): Promise<Array<{ relativePath: string; bytes: Buffer }>> {
    const parts: Array<{ relativePath: string; bytes: Buffer }> = [];
    let entries: string[];
    try {
      entries = await readdir(filesRoot);
    } catch {
      return parts;
    }
    for (const entry of entries) {
      const absolute = nodePath.join(filesRoot, entry);
      // 用 `lstat`：**不跟随符号链接**（跟随会把包外的文件读进来并上传）
      const entryStat = await lstat(absolute);
      if (!entryStat.isFile()) {
        continue;
      }
      parts.push({ relativePath: entry, bytes: await readFile(absolute) });
    }
    return parts;
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
