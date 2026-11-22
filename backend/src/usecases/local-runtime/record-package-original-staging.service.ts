// src/usecases/local-runtime/record-package-original-staging.service.ts

/**
 * 记录包原件的**服务端暂存**（任务 09 S3 补丁 P3）。
 *
 * 职责边界：
 * - 只有本服务**读包内文件**：路径经清单策略解析（禁绝对路径／`..`／反斜杠／盘符），
 *   并且必须是**普通文件**（软链接一律拒绝，防逃逸）；
 * - 读取后按清单登记的 `sha256`／`byte_size` **逐文件复核**，不符即失败关闭；
 * - 复核通过的字节登记为任务 11 的**临时文件**（`VALID`+`TEMPORARY`＋`businessId=null`），
 *   把登记事实交给来源域写入方在**自身事务内**绑定；
 * - 写入方因此**永远拿不到路径**，只有 `fileId`/`uploadContextId`。
 *
 * 失败补偿口径（与任务 11 既有契约一致）：**不删除**已落盘的字节，暂存行停在
 * `TEMPORARY`（可追踪、无业务绑定）；导入逐条结果如实登记失败原因。
 * 任务 11 目前**没有**过期暂存清理任务（无 delete 接口），因此"孤儿暂存自动清理"
 * 是明确缺口，不在此伪装成已实现。
 */

import { RECORD_PACKAGE_ERROR, DomainError } from '@core/common/errors/domain-error';
import { resolvePackageFilePath } from '@core/local-runtime/policy/record-package-manifest.policy';
import { sha256FileDigest } from '@core/common/digest/file-digest';
import { Inject, Injectable } from '@nestjs/common';
import { lstatSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { randomUUID } from 'node:crypto';

import { StoredFileService } from '@src/modules/lithography/stored-file.service';

import {
  STORED_FILE_STORAGE,
  type StoredFileStorage,
} from '@usecases/common/ports/stored-file-storage.contract';

/** 任务 11 的用途（按来源允许的附件用途） */
export type RecordPackageOriginalBusinessType = 'MAINTENANCE_REPORT';

/** 已暂存的原件事实（交给来源域写入方） */
export type StagedPackageOriginal = {
  fileId: string;
  uploadContextId: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
};

/** 扩展名 → MIME（保守回落；字节完整性以清单摘要为准） */
const MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.txt', 'text/plain'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
]);

@Injectable()
export class RecordPackageOriginalStagingService {
  constructor(
    @Inject(STORED_FILE_STORAGE)
    private readonly storage: StoredFileStorage,
    private readonly storedFileService: StoredFileService,
  ) {}

  /**
   * 把包内原件暂存为任务 11 的临时文件。
   *
   * @param input.packagePath 包根（本机绝对路径，由编排侧校验过）
   * @param input.files 清单登记的文件（相对路径＋摘要＋字节数）
   */
  async stage(input: {
    packagePath: string;
    files: { relative_path: string; sha256: string; byte_size: number }[];
    businessType: RecordPackageOriginalBusinessType;
    /** 上传人＝包内来源账号（绑定段要求"暂存上传者＝绑定账号"） */
    uploadedByAccountId: number;
    ownerOrganizationId: number;
  }): Promise<StagedPackageOriginal[]> {
    const staged: StagedPackageOriginal[] = [];
    for (const file of input.files) {
      staged.push(await this.stageOne(input, file));
    }
    return staged;
  }

  /** 暂存单个文件：路径安全 → 普通文件 → 字节与摘要复核 → 落盘 → 登记临时文件 */
  private async stageOne(
    input: {
      packagePath: string;
      businessType: RecordPackageOriginalBusinessType;
      uploadedByAccountId: number;
      ownerOrganizationId: number;
    },
    file: { relative_path: string; sha256: string; byte_size: number },
  ): Promise<StagedPackageOriginal> {
    const absolutePath = resolvePackageFilePath(input.packagePath, file.relative_path);
    const stats = lstatSync(absolutePath);
    if (!stats.isFile()) {
      // 软链接/目录/设备文件一律拒绝：不允许以链接方式逃出包根
      throw new DomainError(
        RECORD_PACKAGE_ERROR.FILE_MISSING,
        `包内文件不是普通文件（拒绝软链接与目录）：${file.relative_path}`,
      );
    }
    if (stats.size !== file.byte_size) {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.FILE_CHECKSUM_MISMATCH,
        `包内文件字节数与清单不符：${file.relative_path}`,
      );
    }
    const digest = await sha256FileDigest(absolutePath);
    if (digest !== file.sha256) {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.FILE_CHECKSUM_MISMATCH,
        `包内文件摘要与清单不符：${file.relative_path}`,
      );
    }

    const content = readFileSync(absolutePath);
    const extension = nodePath.extname(file.relative_path).toLowerCase();
    const storageReference = await this.storage.save(content, extension);
    const fileId = randomUUID();
    const uploadContextId = randomUUID();
    const originalFilename = nodePath.basename(file.relative_path);
    const mimeType = MIME_BY_EXTENSION.get(extension) ?? 'application/octet-stream';

    await this.storedFileService.insertStagedFile({
      fileId,
      uploadedByAccountId: input.uploadedByAccountId,
      ownerOrganizationId: input.ownerOrganizationId,
      storageReference,
      originalFilename,
      mimeType,
      byteSize: file.byte_size,
      checksumSha256: file.sha256,
      businessType: input.businessType,
      uploadContextId,
    });

    return {
      fileId,
      uploadContextId,
      originalFilename,
      mimeType,
      byteSize: file.byte_size,
      checksumSha256: file.sha256,
    };
  }
}
