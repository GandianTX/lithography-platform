// src/usecases/stored-file/download-stored-file.usecase.ts

import { StoredFileBusinessType } from '@app-types/models/stored-file.types';
import { DomainError, STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import {
  normalizeStoredFileId,
  normalizeUploadContextId,
} from '@core/stored-file/policy/stored-file-input.policy';
import { assertStoredFileReadRole } from '@core/stored-file/policy/stored-file-permission.policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { StoredFileQueryService } from '@src/modules/lithography/queries/stored-file.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  STORED_FILE_STORAGE,
  type StoredFileStorage,
} from '@src/usecases/common/ports/stored-file-storage.contract';
import type { DownloadStoredFileQuery, StoredFileDownloadResult } from './stored-file.types';

/**
 * 共用业务原件授权下载用例（R062-03）。
 *
 * - 不把私有存储引用暴露为下载地址：客户端只拿 fileId，服务端授权后回写流；
 * - 授权先于存储打开：未授权请求不会触达存储；
 * - 存储对象缺失/不可读统一 FILE_NOT_AVAILABLE，不泄露路径与引用；
 * - 正式参考资料下载继续走既有 /api/reference-documents 独立资料/有效版本/角色口径，
 *   本用例不改旧接口、不复用旧授权。
 */
@Injectable()
export class DownloadStoredFileUsecase {
  private readonly logger = new Logger(DownloadStoredFileUsecase.name);

  constructor(
    private readonly storedFileQueryService: StoredFileQueryService,
    private readonly trustedOrganizationContext: TrustedOrganizationContextQueryService,
    @Inject(STORED_FILE_STORAGE)
    private readonly storage: StoredFileStorage,
  ) {}

  async execute(query: DownloadStoredFileQuery): Promise<StoredFileDownloadResult> {
    const fileId = normalizeStoredFileId(query.fileId);
    if (!fileId) {
      throw new DomainError(STORED_FILE_ERROR.INVALID_PARAMS, '原件编号格式不合法');
    }

    assertStoredFileReadRole(query.session);

    const membership = await this.trustedOrganizationContext.tryResolveForAccount({
      accountId: query.session.accountId,
    });

    const facts = await this.storedFileQueryService.findAuthorizedDownload({
      fileId,
      session: query.session,
      viewerOrganizationId: membership?.organizationId ?? null,
      uploadContextId: normalizeUploadContextId(query.uploadContextId),
      expectedBusinessType: StoredFileBusinessType.REPAIR_PROCESS,
    });
    if (!facts) {
      throw new DomainError(STORED_FILE_ERROR.NOT_FOUND, '原件不存在或无权访问');
    }

    try {
      const content = await this.storage.open(facts.storageReference);
      return {
        fileId: facts.fileId,
        originalFilename: facts.originalFilename,
        mimeType: facts.mimeType,
        content,
      };
    } catch (error) {
      this.logger.warn(
        `原件存储对象不可用: fileId=${facts.fileId} reason=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new DomainError(
        STORED_FILE_ERROR.FILE_NOT_AVAILABLE,
        '原件文件暂时不可用',
        { fileId: facts.fileId },
        error,
      );
    }
  }
}
