// src/usecases/repair-request/bind-repair-process-original.usecase.ts

import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  StoredFileBindingStatus,
  StoredFileBusinessType,
  StoredFileStatus,
} from '@app-types/models/stored-file.types';
import { DomainError, STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import {
  normalizeStoredFileId,
  normalizeUploadContextId,
} from '@core/stored-file/policy/stored-file-input.policy';
import { assertRepairProcessOriginalBindPermission } from '@core/stored-file/policy/stored-file-permission.policy';
import { Inject, Injectable } from '@nestjs/common';
import type {
  RepairProcessBindingTargetSnapshot,
  StoredFileSnapshot,
} from '@src/modules/lithography/lithography.types';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { StoredFileQueryService } from '@src/modules/lithography/queries/stored-file.query.service';
import { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import { StoredFileService } from '@src/modules/lithography/stored-file.service';
import {
  STORED_FILE_STORAGE,
  type StoredFileStorage,
} from '@src/usecases/common/ports/stored-file-storage.contract';

/**
 * 任务 04 绑定命令（同一事务内传入）：
 * 组织、上传者、用途均不从命令取值，全部由服务端会话与原件事实裁决。
 */
export type BindRepairProcessOriginalCommand = {
  session: UsecaseSession;
  requestId: number;
  fileId: string;
  uploadContextId: string;
};

export type RepairProcessOriginalBindingResult = {
  fileId: string;
  businessType: string;
  businessId: string;
  bindingStatus: string;
};

/**
 * 任务 04 保存内部维修过程时的原件绑定能力（任务 11 交付的接入契约）。
 *
 * 事务边界：
 * - 本用例不自开事务，必须由任务 04 保存用例在自身事务内调用 `executeInTransaction`；
 * - 任务 04 必须在同一事务、同一次保存中写入引用该 fileId 的 repair_process_entry；
 *   绑定与过程记录任一失败，整体回滚，不留下「已绑定但无过程」或「有过程但原件未绑定」；
 * - 本用例只把 stored_file 从 VALID + TEMPORARY 原子推进为 BOUND，并写入 business_id；
 *   不创建、不修改维修过程业务字段。
 *
 * 核对事实（全部来自服务端，不接受前端组织/文件归属声明）：
 * - 当前身份精确为 ENGINEER（写路径失败关闭）；
 * - 可信公司归属（organization membership）；
 * - 原件上传者、归属公司、用途、upload_context_id、VALID + TEMPORARY、未被占用；
 * - 工单存在、未作废、已接单且当前接单人就是操作者、未结束（处理未终结且未关闭）；
 * - 工单的服务公司来自可证明的报修原始输入（intakeId 非空），且与当前工程师可信组织一致；
 *   旧 owner、客户公司、历史接单人和客户端传入组织都不能替代服务归属；
 * - 存储对象实际字节数与 SHA-256 与登记一致（防替换/截断）。
 *
 * 并发：
 * - 先对 stored_file 行加 pessimistic_write 锁，再条件 UPDATE（仅 TEMPORARY 且 business_id 为空）；
 * - 重复/并发绑定只有一个事务命中，另一个得到 ALREADY_BOUND，不产生双绑定。
 */
@Injectable()
export class BindRepairProcessOriginalUsecase {
  constructor(
    private readonly storedFileService: StoredFileService,
    private readonly storedFileQueryService: StoredFileQueryService,
    private readonly repairRequestService: RepairRequestService,
    private readonly trustedOrganizationContext: TrustedOrganizationContextQueryService,
    private readonly localWriteHoldService: LocalWriteHoldService,
    @Inject(STORED_FILE_STORAGE)
    private readonly storage: StoredFileStorage,
  ) {}

  async executeInTransaction(
    command: BindRepairProcessOriginalCommand,
    transactionContext: PersistenceTransactionContext,
  ): Promise<RepairProcessOriginalBindingResult> {
    assertRepairProcessOriginalBindPermission(command.session);

    if (!Number.isSafeInteger(command.requestId) || command.requestId <= 0) {
      throw new DomainError(STORED_FILE_ERROR.INVALID_PARAMS, '工单编号格式不合法');
    }
    const fileId = normalizeStoredFileId(command.fileId);
    if (!fileId) {
      throw new DomainError(STORED_FILE_ERROR.INVALID_PARAMS, '原件编号格式不合法');
    }
    const uploadContextId = normalizeUploadContextId(command.uploadContextId);
    if (!uploadContextId) {
      throw new DomainError(STORED_FILE_ERROR.INVALID_PARAMS, '上传上下文缺失或格式不合法');
    }

    const membership = await this.trustedOrganizationContext.resolveForAccount({
      accountId: command.session.accountId,
      transactionContext,
    });

    // 恢复期写入冻结：stored_file 属恢复范围表，冻结期不得绑定原件
    await this.localWriteHoldService.assertBusinessWritableInTransaction({
      organizationId: membership.organizationId,
      transactionContext,
    });

    const file = await this.storedFileService.lockForBinding(fileId, transactionContext);
    if (!file) {
      throw new DomainError(STORED_FILE_ERROR.NOT_FOUND, '原件不存在或无权绑定');
    }

    this.assertFileBindableFacts(file, command, membership.organizationId, uploadContextId);

    const target = await this.repairRequestService.findProcessBindingTargetForUpdate(
      command.requestId,
      transactionContext,
    );
    this.assertWorkOrderBindableFacts(target, command, membership.organizationId);

    if (await this.storedFileQueryService.isReferencedByRepairProcess(fileId, transactionContext)) {
      throw new DomainError(STORED_FILE_ERROR.ALREADY_BOUND, '原件已被维修过程占用');
    }

    await this.assertStorageIntegrity(file);

    const affected = await this.storedFileService.bindIfTemporary(
      {
        fileId,
        businessType: StoredFileBusinessType.REPAIR_PROCESS,
        businessId: String(command.requestId),
      },
      transactionContext,
    );
    if (affected !== 1) {
      throw new DomainError(STORED_FILE_ERROR.ALREADY_BOUND, '原件已被绑定，不能重复使用');
    }

    return {
      fileId,
      businessType: StoredFileBusinessType.REPAIR_PROCESS,
      businessId: String(command.requestId),
      bindingStatus: StoredFileBindingStatus.BOUND,
    };
  }

  /** 原件事实核对：上传者/公司/用途/上下文/校验状态/占用状态 */
  private assertFileBindableFacts(
    file: StoredFileSnapshot,
    command: BindRepairProcessOriginalCommand,
    ownerOrganizationId: number,
    uploadContextId: string,
  ): void {
    // 上传者/公司不符按不存在处理，避免借 fileId 探测他人原件
    if (
      file.uploadedByAccountId !== command.session.accountId ||
      file.ownerOrganizationId !== ownerOrganizationId
    ) {
      throw new DomainError(STORED_FILE_ERROR.NOT_FOUND, '原件不存在或无权绑定');
    }

    const bindingStatus = file.bindingStatus as StoredFileBindingStatus;
    if (bindingStatus === StoredFileBindingStatus.BOUND || file.businessId !== null) {
      throw new DomainError(STORED_FILE_ERROR.ALREADY_BOUND, '原件已被绑定，不能重复使用');
    }
    if (
      (file.businessType as StoredFileBusinessType) !== StoredFileBusinessType.REPAIR_PROCESS ||
      file.uploadContextId !== uploadContextId
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

  /** 工单事实核对：存在、未作废、本人接单、未结束、可信服务公司一致 */
  private assertWorkOrderBindableFacts(
    target: RepairProcessBindingTargetSnapshot | null,
    command: BindRepairProcessOriginalCommand,
    viewerOrganizationId: number,
  ): void {
    const trustedServiceOrganizationId =
      target !== null && target.intakeId !== null ? target.serviceOrganizationId : null;
    if (
      !target ||
      target.deprecated ||
      !target.isAccepted ||
      target.acceptedByEngineerAccountId !== command.session.accountId ||
      isEnded(target.handlingStatus, target.closureStatus) ||
      trustedServiceOrganizationId === null ||
      trustedServiceOrganizationId !== viewerOrganizationId
    ) {
      throw new DomainError(
        STORED_FILE_ERROR.WORK_ORDER_NOT_BINDABLE,
        '工单当前状态不允许保存内部维修过程',
      );
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

/** 已结束：处理状态 COMPLETED/UNRESOLVED 或关单状态 CLOSED（旧行可空） */
function isEnded(handlingStatus: string | null, closureStatus: string | null): boolean {
  return (
    handlingStatus === 'COMPLETED' || handlingStatus === 'UNRESOLVED' || closureStatus === 'CLOSED'
  );
}
