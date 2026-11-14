// src/usecases/stored-file/upload-stored-file.usecase.ts

import { createHash, randomUUID } from 'node:crypto';

import { DomainError, STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import { assertStoredFileUploadQualification } from '@core/stored-file/policy/stored-file-permission.policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { StoredFileService } from '@src/modules/lithography/stored-file.service';
import { StoredFileQueryService } from '@src/modules/lithography/queries/stored-file.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { StoredFileMetadataView } from '@src/modules/lithography/lithography.types';
import {
  STORED_FILE_STORAGE,
  type StoredFileStorage,
} from '@src/usecases/common/ports/stored-file-storage.contract';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import {
  extractStoredFileExtension,
  resolveVerifiedStoredFileMimeType,
} from './stored-file-content.policy';
import {
  normalizeStoredFileBusinessType,
  normalizeStoredFileOriginalFilename,
} from './stored-file-input.normalize';
import {
  STORED_FILE_ALLOWED_MIME_TYPES,
  STORED_FILE_UPLOAD_MAX_BYTES,
} from './stored-file-upload.contract';
import type { UploadStoredFileCommand, UploadedStoredFileView } from './stored-file.types';

/**
 * 共用业务原件上传暂存用例（R062-01）。
 *
 * 执行顺序（失败关闭）：
 * 1. 可信会话 + 精确工程师写身份 + 用途白名单 —— 先于任何文件 I/O；
 * 2. 可信公司归属（organization membership）—— 先于任何文件 I/O；
 * 3. 实际内容类型、1..20,000,000 字节、SHA-256 校验（内存中完成）；
 * 4. 私有存储写入（服务端生成引用）；
 * 5. 单事务登记 VALID + TEMPORARY、business_id 为空的暂存记录；
 * 6. 落库失败时补偿删除未登记存储对象，不留下半成品。
 *
 * 暂存成功只表示「已校验」，不表示已绑定任何业务；
 * 绑定必须由任务 04 保存用例在自身事务内调用绑定能力完成。
 */
@Injectable()
export class UploadStoredFileUsecase {
  private readonly logger = new Logger(UploadStoredFileUsecase.name);

  constructor(
    private readonly storedFileService: StoredFileService,
    private readonly storedFileQueryService: StoredFileQueryService,
    private readonly trustedOrganizationContext: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    @Inject(STORED_FILE_STORAGE)
    private readonly storage: StoredFileStorage,
    @Inject(STORED_FILE_ALLOWED_MIME_TYPES)
    private readonly allowedMimeTypes: readonly string[],
  ) {}

  async execute(command: UploadStoredFileCommand): Promise<UploadedStoredFileView> {
    const businessType = normalizeStoredFileBusinessType(command.businessType);
    if (!businessType) {
      throw new DomainError(STORED_FILE_ERROR.INVALID_PARAMS, '缺少业务原件用途');
    }

    // 权限与用途先于文件 I/O：未授权请求不会在存储中留下任何字节
    assertStoredFileUploadQualification(command.session, businessType);

    // 可信公司来自服务端成员事实，不接受前端传入组织
    const membership = await this.trustedOrganizationContext.resolveForAccount({
      accountId: command.session.accountId,
    });

    const originalFilename = normalizeStoredFileOriginalFilename(command.file?.originalFilename);
    if (!originalFilename) {
      throw new DomainError(STORED_FILE_ERROR.INVALID_PARAMS, '原件文件名不合法');
    }

    const buffer = command.file?.buffer;
    if (!Buffer.isBuffer(buffer) || buffer.byteLength === 0) {
      throw new DomainError(STORED_FILE_ERROR.UPLOAD_FILE_MISSING, '请上传非空的业务原件');
    }
    if (buffer.byteLength > STORED_FILE_UPLOAD_MAX_BYTES) {
      throw new DomainError(
        STORED_FILE_ERROR.UPLOAD_FILE_TOO_LARGE,
        '业务原件不能超过 20,000,000 字节',
        { byteSize: buffer.byteLength },
      );
    }

    const extension = extractStoredFileExtension(originalFilename);
    const mimeType = resolveVerifiedStoredFileMimeType({
      buffer,
      originalFilename,
      allowedMimeTypes: this.allowedMimeTypes,
    });
    if (!mimeType) {
      throw new DomainError(
        STORED_FILE_ERROR.UPLOAD_FILE_TYPE_NOT_ALLOWED,
        '业务原件类型不在允许范围内，或实际内容与扩展名不一致',
      );
    }

    const checksumSha256 = createHash('sha256').update(buffer).digest('hex');
    const fileId = randomUUID();
    const uploadContextId = randomUUID();

    let storageReference: string | null = null;
    let callbackCompleted = false;
    try {
      try {
        storageReference = await this.storage.save(buffer, extension);
      } catch (error) {
        // 存储失败对外只暴露受控错误，不泄露路径/引用
        throw new DomainError(
          STORED_FILE_ERROR.UPLOAD_FAILED,
          '原件暂存失败，请稍后重试',
          { fileId },
          error,
        );
      }
      const savedStorageReference = storageReference;

      const snapshot = await this.transactionRunner.run(async (transactionContext) =>
        this.storedFileService.insertStagedFile(
          {
            fileId,
            uploadedByAccountId: command.session.accountId,
            ownerOrganizationId: membership.organizationId,
            storageReference: savedStorageReference,
            originalFilename,
            mimeType,
            byteSize: buffer.byteLength,
            checksumSha256,
            businessType,
            uploadContextId,
          },
          transactionContext,
        ),
      );
      callbackCompleted = true;

      return {
        fileId: snapshot.fileId,
        businessType: snapshot.businessType,
        originalFilename: snapshot.originalFilename,
        mimeType: snapshot.mimeType,
        byteSize: snapshot.byteSize,
        checksumSha256: snapshot.checksumSha256,
        status: snapshot.status as StoredFileMetadataView['status'],
        bindingStatus: snapshot.bindingStatus as StoredFileMetadataView['bindingStatus'],
        businessId: snapshot.businessId,
        uploadContextId: snapshot.uploadContextId,
        verifiedAt: snapshot.verifiedAt,
        createdAt: snapshot.createdAt,
      };
    } catch (error) {
      // 存储已写入但落库未确认：先探测是否已有登记，避免误删已提交对象
      if (storageReference && !callbackCompleted) {
        await this.compensateStorage(storageReference);
      }
      throw error;
    }
  }

  private async compensateStorage(storageReference: string): Promise<void> {
    try {
      if (await this.storedFileQueryService.isStorageReferenceReferenced(storageReference)) {
        return;
      }
      await this.storage.delete(storageReference);
    } catch (cleanupError) {
      // 补偿失败不覆盖原始错误；由运维按日志人工清理，不向客户端暴露路径
      this.logger.warn(`原件暂存落库失败后的存储补偿未完成: ${describeError(cleanupError)}`);
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
