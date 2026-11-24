// src/usecases/stored-file/upload-stored-file.usecase.ts

import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import { createHash, randomUUID } from 'node:crypto';

import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  DomainError,
  REPAIR_REQUEST_ERROR,
  STORED_FILE_ERROR,
} from '@core/common/errors/domain-error';
import {
  assertStoredFileUploadQualification,
  isRepairRequestBusinessType,
} from '@core/stored-file/policy/stored-file-permission.policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
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
 * 1. 可信会话 + 用途级写身份 + 用途白名单 —— 先于任何文件 I/O；
 * 2. 可信公司归属（工程师按成员关系、客户按账号的公司信息）—— 先于任何文件 I/O；
 * 3. 实际内容类型、1..20,000,000 字节、SHA-256 校验（内存中完成）；
 * 4. 恢复期冻结**只读预检** —— 先于任何文件 I/O：冻结已在生效时不得写下字节；
 * 5. 单事务：恢复期冻结**事务内守卫**（取范围共享锁，持有到提交／回滚）
 *    → **私有存储写入**（同一事务、同一把共享锁内）
 *    → 登记 VALID + TEMPORARY、business_id 为空的暂存记录；
 * 6. 写盘失败：事务回滚，只记录写盘失败与文件状态未确认，不探测、不删除；
 * 7. 落库失败时不猜测事务终局：保留存储对象并记录可排查诊断，由人工核对后清理。
 *
 * 冻结守卫分两层（独立验收 P1-1）：
 * - **只读预检**（第 4 步）挡住"冻结已在生效"的写入，避免产生字节副作用；
 * - **事务内守卫**（第 5 步）取范围共享锁并锁定读冻结事实，
 *   锁随事务提交／回滚释放 ⇒ 恢复建立冻结必须等这次上传收口之后才成立，
 *   杜绝"检查未冻结 → 恢复建立冻结 → 登记穿透"的窗口。
 *
 * **写盘也在事务内**（任务 09 恢复链最小修复 01）：
 * 此前写盘发生在事务与共享锁**之外**，于是"预检通过 → 恢复建立冻结 → 继续写盘"
 * 会留下**没有元数据的字节**（恢复范围里的孤儿文件）。现在写盘与登记同处一个
 * 事务、同一把范围共享锁 ⇒
 * - 冻结已生效 ⇒ 守卫先拒绝，**一个字节都不会写下**；
 * - 冻结在上传途中建立 ⇒ 恢复侧的排他范围锁必须等本事务提交／回滚后才成立。
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
    private readonly localWriteHoldService: LocalWriteHoldService,
    private readonly accountQueryService: AccountQueryService,
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

    // 可信公司来自服务端事实，不接受前端传入组织
    const ownerOrganizationId = await this.resolveOwnerOrganizationId(
      command.session,
      businessType,
    );

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

    // 恢复期写入冻结**只读预检**（先于任何文件 I/O）：
    // 冻结已在生效时不得写下字节（stored_file 属恢复范围表）。
    // 只读预检不持锁，只负责"快速拒绝"；互斥由下面的**事务内守卫**提供。
    await this.localWriteHoldService.assertBusinessWritable({
      organizationId: ownerOrganizationId,
    });

    let storageReference: string | null = null;
    let storageSaveCompleted = false;
    let registrationCallbackCompleted = false;
    try {
      const snapshot = await this.transactionRunner.run(async (transactionContext) => {
        // 恢复期写入冻结（**事务内**）：stored_file 属恢复范围表，冻结期不得新增暂存原件。
        // 事务内守卫取范围共享锁 ⇒ 锁持有到本事务提交／回滚，
        // 恢复建立冻结必须等这次上传收口之后才成立（独立验收 P1-1）。
        await this.localWriteHoldService.assertBusinessWritableInTransaction({
          organizationId: ownerOrganizationId,
          transactionContext,
        });
        // **写盘与登记同处一个事务、同一把范围共享锁**（任务 09 恢复链最小修复 01）：
        // 冻结已生效时守卫先拒绝 ⇒ 不会留下"没有元数据的字节"；
        // 冻结在上传途中建立时，恢复侧的排他范围锁必须等本事务收口之后才成立。
        const savedStorageReference = await this.saveToStorage({
          buffer,
          extension,
          fileId,
        });
        storageReference = savedStorageReference;
        storageSaveCompleted = true;
        const stagedFile = await this.storedFileService.insertStagedFile(
          {
            fileId,
            uploadedByAccountId: command.session.accountId,
            ownerOrganizationId,
            storageReference: savedStorageReference,
            originalFilename,
            mimeType,
            byteSize: buffer.byteLength,
            checksumSha256,
            businessType,
            uploadContextId,
          },
          transactionContext,
        );
        // 事务回调内登记成功、返回前落标记：runner 随后报错时仍能区分「已登记」与「未登记」
        registrationCallbackCompleted = true;
        return stagedFile;
      });

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
      if (!storageSaveCompleted) {
        // 写盘被拒绝时事务已回滚、**没有登记任何元数据**：只记录阶段事实，不探测、不删除。
        this.reportStorageWriteFailure({
          fileId,
          uploadContextId,
          businessType,
          failure: error,
        });
      } else {
        // 事务契约不提供明确终局：回调完成、回调抛错、提交回执丢失都可能是未知结果，
        // 独立连接查不到引用也不等于已回滚。因此一律保留存储对象，只记录诊断供人工核对。
        await this.reportRetainedStorage({
          storageReference,
          fileId,
          uploadContextId,
          businessType,
          registrationCallbackCompleted,
          failure: error,
        });
      }
      throw error;
    }
  }

  /**
   * 私有存储写入（**在业务事务与范围共享锁之内**执行）。
   *
   * 存储失败对外只暴露受控错误，不泄露路径／引用；异常在事务回调内抛出 ⇒
   * 事务回滚 ⇒ 不会留下已登记的半截状态。
   */
  private async saveToStorage(params: {
    buffer: Buffer;
    extension: string;
    fileId: string;
  }): Promise<string> {
    try {
      return await this.storage.save(params.buffer, params.extension);
    } catch (error) {
      throw new DomainError(
        STORED_FILE_ERROR.UPLOAD_FAILED,
        '原件暂存失败，请稍后重试',
        { fileId: params.fileId },
        error,
      );
    }
  }

  /**
   * 原件归属公司解析（服务端事实，失败关闭）。
   *
   * - `REPAIR_PROCESS`（工程师）：沿用组织成员关系解析，保持任务 11 原口径；
   * - `REPAIR_REQUEST`（客户）：客户公司只认同账号在 `base_user_info` 上的
   *   `customer_organization_id`（与客户创建报修同一真源）；缺失即拒绝上传，
   *   避免落出「有原件但没有任何组织可核权」的孤儿暂存记录。
   *
   * 归属解析先于任何文件 I/O：未通过归属校验的请求不会在存储中留下字节。
   */
  private async resolveOwnerOrganizationId(
    session: UsecaseSession,
    businessType: string,
  ): Promise<number> {
    if (isRepairRequestBusinessType(businessType)) {
      const customerOrganizationId = await this.accountQueryService.findCustomerOrganizationId({
        accountId: session.accountId,
      });
      if (customerOrganizationId === null) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.CUSTOMER_COMPANY_REQUIRED,
          '请先在账号设置中补充公司信息后再上传报修原件',
        );
      }
      return customerOrganizationId;
    }

    const membership = await this.trustedOrganizationContext.resolveForAccount({
      accountId: session.accountId,
    });
    return membership.organizationId;
  }

  private reportStorageWriteFailure(params: {
    fileId: string;
    uploadContextId: string;
    businessType: string;
    failure: unknown;
  }): void {
    // 写盘阶段只记录事实：事务已回滚、**未登记任何元数据**、文件状态未确认；
    // 不探测引用，也不声称文件已保留。
    try {
      this.logger.warn(
        `原件写盘失败，事务已回滚且未登记元数据，文件状态未确认: ${JSON.stringify({
          event: 'stored_file.upload.storage_save_failed',
          fileId: params.fileId,
          uploadContextId: params.uploadContextId,
          businessType: params.businessType,
          stage: 'storage-save',
          transactionStarted: true,
          transactionOutcome: 'rolled-back',
          registered: false,
          fileState: 'unconfirmed',
          referenceProbe: 'skipped',
          failure: describeError(params.failure),
        })}`,
      );
    } catch {
      // 诊断失败静默收敛：主错误由调用方原样收到
    }
  }

  private async reportRetainedStorage(params: {
    storageReference: string | null;
    fileId: string;
    uploadContextId: string;
    businessType: string;
    registrationCallbackCompleted: boolean;
    failure: unknown;
  }): Promise<void> {
    // 诊断是尽力而为：引用探测、格式化或日志本身失败都不能覆盖主错误，也不能触发删除
    try {
      const referenceProbe = await this.probeStorageReference(params.storageReference);
      // 仅记录内部诊断：不向客户端返回存储引用或服务器路径，也不改变主错误
      this.logger.warn(
        `原件暂存落库失败后的存储对象已保留待人工核对: ${JSON.stringify({
          event: 'stored_file.upload.compensation_retained',
          fileId: params.fileId,
          uploadContextId: params.uploadContextId,
          businessType: params.businessType,
          storageReference: params.storageReference,
          referenceProbe: referenceProbe.status,
          referenceProbeError: referenceProbe.error,
          transactionOutcome: 'unconfirmed',
          registrationCallbackCompleted: params.registrationCallbackCompleted,
          failure: describeError(params.failure),
        })}`,
      );
    } catch {
      // 诊断失败静默收敛：主错误由调用方原样收到，存储对象保持保留状态
    }
  }

  private async probeStorageReference(storageReference: string | null): Promise<{
    status: 'referenced' | 'unreferenced' | 'probe-failed' | 'unavailable';
    error?: string;
  }> {
    if (!storageReference) {
      return { status: 'unavailable' };
    }
    try {
      return {
        status: (await this.storedFileQueryService.isStorageReferenceReferenced(storageReference))
          ? 'referenced'
          : 'unreferenced',
      };
    } catch (probeError) {
      return { status: 'probe-failed', error: describeError(probeError) };
    }
  }
}

function describeError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return '<unformattable-error>';
  }
}
