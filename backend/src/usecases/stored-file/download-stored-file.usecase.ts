// src/usecases/stored-file/download-stored-file.usecase.ts

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { StoredFileBusinessType } from '@app-types/models/stored-file.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { hasRole } from '@core/account/policy/role-access.policy';
import { DomainError, STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import {
  normalizeStoredFileId,
  normalizeUploadContextId,
} from '@core/stored-file/policy/stored-file-input.policy';
import { assertStoredFileReadRole } from '@core/stored-file/policy/stored-file-permission.policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { StoredFileDownloadFacts } from '@src/modules/lithography/lithography.types';
import { StoredFileQueryService } from '@src/modules/lithography/queries/stored-file.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  STORED_FILE_STORAGE,
  type StoredFileStorage,
} from '@src/usecases/common/ports/stored-file-storage.contract';
import {
  resolveStoredFileAdminScope,
  resolveStoredFileViewerOrganizationId,
} from './stored-file-admin-scope';
import { STORED_FILE_UPLOAD_MAX_BYTES } from './stored-file-upload.contract';
import type { DownloadStoredFileQuery, StoredFileDownloadResult } from './stored-file.types';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * 共用业务原件授权下载用例（R062-03）。
 *
 * - 不把私有存储引用暴露为下载地址：客户端只拿 fileId，服务端授权后回写流；
 * - 授权先于存储打开：未授权请求不会触达存储；
 * - 只打开一次存储，按登记字节数有界读取，并核对长度与 SHA-256；
 * - 校验通过后才把同一份已校验字节交给边界层发送，不重新打开、不发送未校验内容；
 * - 登记值无效、读取超限、内容不匹配、读取失败、客户端断开统一 FILE_NOT_AVAILABLE，
 *   不泄露路径与引用；
 * - 正式参考资料下载继续走既有 /api/reference-documents 独立资料/有效版本/角色口径，
 *   本用例不改旧接口、不复用旧授权。
 */
@Injectable()
export class DownloadStoredFileUsecase {
  private readonly logger = new Logger(DownloadStoredFileUsecase.name);

  constructor(
    private readonly storedFileQueryService: StoredFileQueryService,
    private readonly trustedOrganizationContext: TrustedOrganizationContextQueryService,
    private readonly accountQueryService: AccountQueryService,
    @Inject(STORED_FILE_STORAGE)
    private readonly storage: StoredFileStorage,
  ) {}

  async execute(query: DownloadStoredFileQuery): Promise<StoredFileDownloadResult> {
    const fileId = normalizeStoredFileId(query.fileId);
    if (!fileId) {
      throw new DomainError(STORED_FILE_ERROR.INVALID_PARAMS, '原件编号格式不合法');
    }

    assertStoredFileReadRole(query.session);

    const adminScope = await resolveStoredFileAdminScope({
      session: query.session,
      accountQueryService: this.accountQueryService,
      trustedOrganizationContext: this.trustedOrganizationContext,
    });
    const viewerOrganizationId = await resolveStoredFileViewerOrganizationId({
      session: query.session,
      adminScope,
      trustedOrganizationContext: this.trustedOrganizationContext,
    });

    const facts = await this.storedFileQueryService.findAuthorizedDownload({
      fileId,
      session: query.session,
      viewerOrganizationId,
      uploadContextId: normalizeUploadContextId(query.uploadContextId),
      // 任务 03 第三段起客户读链路开通：客户仅读本人报修原件（REPAIR_REQUEST），
      // 工程师/管理员链路（REPAIR_PROCESS）口径不变；用途级归属仍由 QueryService 裁决
      expectedBusinessType: hasRole(query.session.roles, IdentityTypeEnum.ENGINEER)
        ? StoredFileBusinessType.REPAIR_PROCESS
        : StoredFileBusinessType.REPAIR_REQUEST,
      ...(adminScope ? { adminOrganizationId: adminScope.organizationId } : {}),
    });
    if (!facts) {
      throw new DomainError(STORED_FILE_ERROR.NOT_FOUND, '原件不存在或无权访问');
    }

    if (!this.hasValidRegisteredIntegrity(facts)) {
      throw new DomainError(STORED_FILE_ERROR.FILE_NOT_AVAILABLE, '原件文件暂时不可用', {
        fileId: facts.fileId,
      });
    }

    const content = await this.openVerifiedSource(facts, query.signal);
    const verifiedBytes = await this.readVerifiedBytes({
      content,
      facts,
      signal: query.signal,
    });

    return {
      fileId: facts.fileId,
      originalFilename: facts.originalFilename,
      mimeType: facts.mimeType,
      // 只发送本轮已核对过的同一份字节；不重新打开存储
      content: Readable.from([verifiedBytes]),
    };
  }

  /** 登记值必须先可信：大小在 1..业务上限内，SHA-256 为 64 位十六进制 */
  private hasValidRegisteredIntegrity(facts: StoredFileDownloadFacts): boolean {
    return (
      Number.isSafeInteger(facts.byteSize) &&
      facts.byteSize > 0 &&
      facts.byteSize <= STORED_FILE_UPLOAD_MAX_BYTES &&
      typeof facts.checksumSha256 === 'string' &&
      SHA256_HEX_PATTERN.test(facts.checksumSha256)
    );
  }

  /** 打开存储，并在客户端已断开（含打开迟到返回）时立即销毁源流 */
  private async openVerifiedSource(
    facts: StoredFileDownloadFacts,
    signal?: AbortSignal,
  ): Promise<Readable> {
    let content: Readable;

    try {
      content = await this.storage.open(facts.storageReference);
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

    if (signal?.aborted) {
      this.destroyContentQuietly(content);
      throw new DomainError(STORED_FILE_ERROR.FILE_NOT_AVAILABLE, '原件文件暂时不可用', {
        fileId: facts.fileId,
      });
    }

    return content;
  }

  /**
   * 有界读取并核对长度与 SHA-256。
   * 读取最多到登记字节数（登记值已限制在业务上限内），超出即销毁源流并拒绝。
   */
  private async readVerifiedBytes(params: {
    content: Readable;
    facts: StoredFileDownloadFacts;
    signal?: AbortSignal;
  }): Promise<Buffer> {
    const { content, facts, signal } = params;
    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    let totalBytes = 0;
    let completed = false;

    const onAbort = (): void => {
      this.destroyContentQuietly(content);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      for await (const chunk of content as AsyncIterable<Buffer | string>) {
        if (signal?.aborted) {
          throw this.unavailable(facts.fileId);
        }

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.byteLength;
        if (totalBytes > facts.byteSize) {
          throw this.unavailable(facts.fileId);
        }

        hash.update(buffer);
        chunks.push(buffer);
      }
      completed = true;
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      throw new DomainError(
        STORED_FILE_ERROR.FILE_NOT_AVAILABLE,
        '原件文件暂时不可用',
        { fileId: facts.fileId },
        error,
      );
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (!completed) {
        this.destroyContentQuietly(content);
      }
    }

    if (signal?.aborted) {
      throw this.unavailable(facts.fileId);
    }
    if (totalBytes !== facts.byteSize) {
      throw this.unavailable(facts.fileId);
    }
    if (hash.digest('hex') !== facts.checksumSha256.toLowerCase()) {
      throw this.unavailable(facts.fileId);
    }

    return Buffer.concat(chunks, totalBytes);
  }

  private unavailable(fileId: string): DomainError {
    return new DomainError(STORED_FILE_ERROR.FILE_NOT_AVAILABLE, '原件文件暂时不可用', {
      fileId,
    });
  }

  /** 销毁源流，并把销毁回调抛出的读流错误留在本地监听器内 */
  private destroyContentQuietly(content: Readable): void {
    const swallowError = (): void => undefined;
    const removeSwallow = (): void => {
      content.removeListener('error', swallowError);
    };
    content.on('error', swallowError);
    if (content.closed) {
      removeSwallow();
      content.destroy();
      return;
    }
    content.once('close', removeSwallow);
    content.destroy();
  }
}
