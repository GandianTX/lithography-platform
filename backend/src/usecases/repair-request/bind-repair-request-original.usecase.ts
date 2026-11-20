// src/usecases/repair-request/bind-repair-request-original.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  StoredFileBindingStatus,
  StoredFileBusinessType,
  StoredFileStatus,
} from '@app-types/models/stored-file.types';
import {
  DomainError,
  REPAIR_REQUEST_ERROR,
  STORED_FILE_ERROR,
} from '@core/common/errors/domain-error';
import {
  normalizeStoredFileId,
  normalizeUploadContextId,
} from '@core/stored-file/policy/stored-file-input.policy';
import { assertRepairRequestOriginalBindPermission } from '@core/stored-file/policy/stored-file-permission.policy';
import { Inject, Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { StoredFileSnapshot } from '@src/modules/lithography/lithography.types';
import { StoredFileService } from '@src/modules/lithography/stored-file.service';
import {
  STORED_FILE_STORAGE,
  type StoredFileStorage,
} from '@src/usecases/common/ports/stored-file-storage.contract';

/**
 * 任务 03 绑定命令（必须在提交报修的同一事务内调用）。
 *
 * `session` 来自可信 JWT；`intakeId` 是本次事务刚插入的原稿主键；
 * 上传者、归属公司、用途、上传上下文全部由服务端事实裁决，命令里不接受组织声明。
 */
export type BindRepairRequestOriginalCommand = {
  session: UsecaseSession;
  intakeId: number;
  fileId: string;
  uploadContextId: string;
};

export type RepairRequestOriginalBindingResult = {
  fileId: string;
  businessType: string;
  businessId: string;
  bindingStatus: string;
};

/**
 * 客户报修原件绑定能力（任务 11 原件底座在任务 03 的接入点）。
 *
 * 事务边界：
 * - 本用例不自开事务，必须由创建报修用例在自身事务内调用 `executeInTransaction`；
 * - 调用方必须在同一事务、同一次提交中写入引用该 fileId 的 `repair_request_intake`；
 *   原稿与原件绑定任一失败则整体回滚，不留下「已绑定但无原稿」或「有原稿但原件未绑定」；
 * - 本用例只把 stored_file 从 VALID + TEMPORARY 原子推进为 BOUND 并写 business_id
 *   （= 原稿主键），不创建、不修改任何报修业务字段。
 *
 * 核对事实（全部来自服务端）：
 * - 当前身份为客户（与创建报修同一口径）；
 * - 原件上传者 = 当前账号、归属公司 = 当前可信客户公司（异主附件按不存在拒绝）；
 * - 用途 = REPAIR_REQUEST、upload_context_id 精确匹配、VALID + TEMPORARY、未被占用；
 * - 存储对象实际字节数与 SHA-256 与登记一致（防替换/截断）。
 *
 * 并发：先对 stored_file 行加 pessimistic_write 锁，再条件 UPDATE
 * （仅 VALID + TEMPORARY 且 business_id 为空），重复/并发绑定只有一个事务命中。
 */
@Injectable()
export class BindRepairRequestOriginalUsecase {
  constructor(
    private readonly storedFileService: StoredFileService,
    private readonly accountQueryService: AccountQueryService,
    @Inject(STORED_FILE_STORAGE)
    private readonly storage: StoredFileStorage,
  ) {}

  async executeInTransaction(
    command: BindRepairRequestOriginalCommand,
    transactionContext: PersistenceTransactionContext,
  ): Promise<RepairRequestOriginalBindingResult> {
    assertRepairRequestOriginalBindPermission(command.session);

    if (!Number.isSafeInteger(command.intakeId) || command.intakeId <= 0) {
      throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '报修原稿编号格式不合法');
    }
    const fileId = normalizeStoredFileId(command.fileId);
    if (!fileId) {
      throw new DomainError(STORED_FILE_ERROR.INVALID_PARAMS, '原件编号格式不合法');
    }
    const uploadContextId = normalizeUploadContextId(command.uploadContextId);
    if (!uploadContextId) {
      throw new DomainError(STORED_FILE_ERROR.INVALID_PARAMS, '上传上下文缺失或格式不合法');
    }

    // 客户可信公司：与上传时同一真源（base_user_info.customer_organization_id），
    // 在同一事务内复核；归属缺失/变更一律失败关闭，不按客户端自报组织兜底。
    const ownerOrganizationId = await this.accountQueryService.findCustomerOrganizationId({
      accountId: command.session.accountId,
      transactionContext,
    });
    if (ownerOrganizationId === null) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.CUSTOMER_COMPANY_REQUIRED,
        '请先在账号设置中补充公司信息后再提交维修申请',
      );
    }

    const file = await this.storedFileService.lockForBinding(fileId, transactionContext);
    if (!file) {
      throw new DomainError(STORED_FILE_ERROR.NOT_FOUND, '原件不存在或无权绑定');
    }

    this.assertFileBindableFacts(file, {
      accountId: command.session.accountId,
      ownerOrganizationId,
      uploadContextId,
    });

    await this.assertStorageIntegrity(file);

    const affected = await this.storedFileService.bindIfTemporary(
      {
        fileId,
        businessType: StoredFileBusinessType.REPAIR_REQUEST,
        businessId: String(command.intakeId),
      },
      transactionContext,
    );
    if (affected !== 1) {
      throw new DomainError(STORED_FILE_ERROR.ALREADY_BOUND, '原件已被绑定，不能重复使用');
    }

    return {
      fileId,
      businessType: StoredFileBusinessType.REPAIR_REQUEST,
      businessId: String(command.intakeId),
      bindingStatus: StoredFileBindingStatus.BOUND,
    };
  }

  /** 原件事实核对：上传者/公司/用途/上下文/校验状态/占用状态 */
  private assertFileBindableFacts(
    file: StoredFileSnapshot,
    expected: {
      accountId: number;
      ownerOrganizationId: number;
      uploadContextId: string;
    },
  ): void {
    // 上传者/公司不符按不存在处理，避免借 fileId 探测他人原件
    if (
      file.uploadedByAccountId !== expected.accountId ||
      file.ownerOrganizationId !== expected.ownerOrganizationId
    ) {
      throw new DomainError(STORED_FILE_ERROR.NOT_FOUND, '原件不存在或无权绑定');
    }

    const bindingStatus = file.bindingStatus as StoredFileBindingStatus;
    if (bindingStatus === StoredFileBindingStatus.BOUND || file.businessId !== null) {
      throw new DomainError(STORED_FILE_ERROR.ALREADY_BOUND, '原件已被绑定，不能重复使用');
    }
    if (
      (file.businessType as StoredFileBusinessType) !== StoredFileBusinessType.REPAIR_REQUEST ||
      file.uploadContextId !== expected.uploadContextId
    ) {
      throw new DomainError(STORED_FILE_ERROR.NOT_BINDABLE, '原件用途或上传上下文与当前业务不匹配');
    }
    if (
      (file.status as StoredFileStatus) !== StoredFileStatus.VALID ||
      file.verifiedAt === null ||
      bindingStatus !== StoredFileBindingStatus.TEMPORARY
    ) {
      throw new DomainError(STORED_FILE_ERROR.NOT_BINDABLE, '原件尚未通过完整校验，不能绑定');
    }
  }

  /**
   * 完整性核对失败统一阻断绑定：
   * - 存储对象缺失/不可读 → 抛错；
   * - 字节数或 SHA-256 不一致 → false；
   * 两者都不允许继续写业务关系。
   */
  private async assertStorageIntegrity(file: {
    fileId: string;
    storageReference: string;
    checksumSha256: string;
    byteSize: number;
  }): Promise<void> {
    let intact: boolean;
    try {
      intact = await this.storage.verifyIntegrity(
        file.storageReference,
        file.checksumSha256,
        file.byteSize,
      );
    } catch {
      intact = false;
    }
    if (!intact) {
      throw new DomainError(STORED_FILE_ERROR.INTEGRITY_FAILED, '原件完整性核对失败，不能绑定', {
        fileId: file.fileId,
      });
    }
  }
}
