// src/usecases/maintenance-report/maintenance-report-attachment-binding.helpers.ts
//
// R050-01 / R045-02 / R051-01 共用的暂存原件绑定事务段：
// 「锁定 stored_file → 逐项核验暂存事实 → 原子绑定 → 按 stored_file 事实登记附件行」。
//
// 三处写入入口共用本段逻辑（同一事务内调用）：
// - 独立报告/工单总结首次保存草稿（R050-01 / R045-02：首存同事务绑定）；
// - 首次未保存表单直接正式提交（R051-01：同事务绑定后冻结）；
// - 已有草稿追加附件（R050-02 / R045-02 续填：add-attachment 用例委托本段）。
//
// 任一事实不成立或绑定未命中即抛错，由调用方所在事务整体回滚：
// 不留半份附件关联，也不占用暂存原件；暂存原件保持 TEMPORARY 可追踪。

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  MaintenanceAttachmentStorageBackend,
  MAINTENANCE_ATTACHMENT_MAX_COUNT,
} from '@app-types/models/maintenance-report.types';
import {
  StoredFileBusinessType,
  StoredFileBindingStatus,
  StoredFileStatus,
} from '@app-types/models/stored-file.types';
import {
  DomainError,
  MAINTENANCE_REPORT_ERROR,
  STORED_FILE_ERROR,
} from '@core/common/errors/domain-error';
import { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import type { MaintenanceReportAttachmentSnapshot } from '@src/modules/lithography/maintenance-report.types';
import { StoredFileService } from '@src/modules/lithography/stored-file.service';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import {
  ATTACHMENT_DESCRIPTION_MAX,
  normalizeAttachmentOptionalText,
  resolveAttachmentSortOrder,
} from './maintenance-report-attachment.input.normalize';
import { trimRequiredText } from './maintenance-report.input.normalize';

/** 首次保存 / 直接正式提交携带的暂存原件（R062-01：file_id + upload_context_id） */
export type MaintenanceReportStagedAttachmentInput = {
  fileId: string;
  uploadContextId: string;
  description?: string | null;
};

/** 归一化后的暂存附件命令；附件缺失时为 null（不进入绑定段） */
export type NormalizedStagedAttachment = {
  fileId: string;
  uploadContextId: string;
  description: string | null;
} | null;

/**
 * 归一化可选暂存附件：file_id / upload_context_id 都是 char(36) 稳定标识，
 * 只给其一或空白直接拒绝，不允许半份上下文进入事务。
 */
export function normalizeStagedAttachment(
  attachment: MaintenanceReportStagedAttachmentInput | null | undefined,
): NormalizedStagedAttachment {
  if (attachment === null || attachment === undefined) {
    return null;
  }
  const fileId = requireStagedFileId(attachment.fileId);
  const uploadContextId = requireStagedFileId(attachment.uploadContextId, '上传上下文');
  const description = normalizeAttachmentOptionalText(
    attachment.description ?? null,
    ATTACHMENT_DESCRIPTION_MAX,
    '附件描述',
  );
  return { fileId, uploadContextId, description };
}

/** 在当前事务内绑定暂存原件到报告并登记附件行；返回登记后的附件快照 */
export async function bindStagedAttachmentToReport(params: {
  storedFileService: StoredFileService;
  maintenanceReportService: MaintenanceReportService;
  maintenanceReportQueryService: MaintenanceReportQueryService;
  reportId: number;
  ownerOrganizationId: number;
  accountId: number;
  attachment: NonNullable<NormalizedStagedAttachment>;
  /** 显式排序号：仅追加挂接入口使用；首存/提交缺省取第一个空闲槽位 */
  requestedSortOrder?: number | null;
  transactionContext: PersistenceTransactionContext;
}): Promise<MaintenanceReportAttachmentSnapshot> {
  const {
    storedFileService,
    maintenanceReportService,
    maintenanceReportQueryService,
    reportId,
    ownerOrganizationId,
    accountId,
    attachment,
    requestedSortOrder,
    transactionContext,
  } = params;
  const { fileId, uploadContextId } = attachment;

  const staged = await storedFileService.lockForBinding(fileId, transactionContext);
  if (staged === null) {
    throw new DomainError(STORED_FILE_ERROR.NOT_FOUND, '暂存原件不存在或不可访问', { fileId });
  }
  // 暂存事实逐项核验：上下文/用途/上传者/公司/状态/绑定状态
  if (staged.uploadContextId !== uploadContextId) {
    throw new DomainError(STORED_FILE_ERROR.NOT_FOUND, '暂存原件不存在或不可访问', { fileId });
  }
  if (
    (staged.businessType as StoredFileBusinessType) !== StoredFileBusinessType.MAINTENANCE_REPORT
  ) {
    throw new DomainError(
      STORED_FILE_ERROR.NOT_BINDABLE,
      '原件用途与报告附件不符，请通过报告附件入口重新上传',
      { fileId, businessType: staged.businessType },
    );
  }
  if (staged.uploadedByAccountId !== accountId) {
    throw new DomainError(STORED_FILE_ERROR.NOT_BINDABLE, '只能绑定本人上传的暂存原件', {
      fileId,
    });
  }
  if (staged.ownerOrganizationId !== ownerOrganizationId) {
    throw new DomainError(STORED_FILE_ERROR.NOT_BINDABLE, '原件归属公司与报告不一致', {
      fileId,
    });
  }
  if ((staged.status as StoredFileStatus) !== StoredFileStatus.VALID) {
    throw new DomainError(
      STORED_FILE_ERROR.FILE_NOT_AVAILABLE,
      '原件尚未完成校验或已失效，请重新上传',
      { fileId, status: staged.status },
    );
  }
  if ((staged.bindingStatus as StoredFileBindingStatus) !== StoredFileBindingStatus.TEMPORARY) {
    throw new DomainError(STORED_FILE_ERROR.ALREADY_BOUND, '原件已绑定其他业务，不能重复绑定', {
      fileId,
    });
  }
  const current = await maintenanceReportQueryService.readCurrentAttachmentsForSubmit(
    reportId,
    transactionContext,
  );
  const sortOrder = resolveAttachmentSortOrder(requestedSortOrder ?? null, current);
  const boundRows = await storedFileService.bindIfTemporary(
    {
      fileId,
      businessType: StoredFileBusinessType.MAINTENANCE_REPORT,
      businessId: String(reportId),
    },
    transactionContext,
  );
  if (boundRows === 0) {
    // 并发占用或状态已变：绑定条件更新未命中，事务整体回滚
    throw new DomainError(STORED_FILE_ERROR.ALREADY_BOUND, '原件已被占用，请重新上传', {
      fileId,
    });
  }
  return maintenanceReportService.insertAttachment(
    {
      reportId,
      fileId: staged.fileId,
      originalFilename: staged.originalFilename,
      mimeType: staged.mimeType,
      byteSize: staged.byteSize,
      checksumSha256: staged.checksumSha256,
      storageBackend: MaintenanceAttachmentStorageBackend.LOCAL,
      storageReference: staged.storageReference,
      sortOrder,
      description: attachment.description,
      uploadedByAccountId: accountId,
    },
    transactionContext,
  );
}

/** fileId / uploadContextId 都是 char(36) 稳定标识：缺省或空白直接拒绝，不进入行锁 */
function requireStagedFileId(value: string, label = '原件编号'): string {
  const trimmed = trimRequiredText(value);
  if (trimmed.length === 0) {
    throw new DomainError(MAINTENANCE_REPORT_ERROR.INVALID_PARAMS, `${label}缺失`, {
      fileId: value,
    });
  }
  return trimmed;
}

/** 绑定裁决模式 */
export type StagedAttachmentBindingMode = 'append' | 'replace';

/**
 * 按 R062-01（单份报告最多 1 份有效原件）裁决暂存原件的绑定/更换：
 *
 * - append：已有任何有效附件即拒绝（挂接入口走独立报错，不动现有附件）；
 * - replace：
 *   - 无有效附件 → 直接绑定；
 *   - 恰好 1 份且 file_id 与新原件相同 → 幂等跳过（合法重试不重复绑定）；
 *   - 恰好 1 份且 file_id 不同 → 同事务内先退役旧附件行、解除旧 stored_file 绑定，
 *     再绑定并登记新原件；任一步失败整体回滚，旧有效关联不会丢失；
 *   - 多于 1 份（历史多附件行）→ 拒绝并提示需逐份处理，不为执行新规则
 *     静默删除或隐藏历史数据。
 */
export async function ensureStagedAttachmentBinding(params: {
  storedFileService: StoredFileService;
  maintenanceReportService: MaintenanceReportService;
  maintenanceReportQueryService: MaintenanceReportQueryService;
  reportId: number;
  ownerOrganizationId: number;
  accountId: number;
  attachment: NonNullable<NormalizedStagedAttachment>;
  mode: StagedAttachmentBindingMode;
  requestedSortOrder?: number | null;
  transactionContext: PersistenceTransactionContext;
}): Promise<MaintenanceReportAttachmentSnapshot> {
  const { maintenanceReportQueryService, maintenanceReportService, storedFileService } = params;
  const current = await maintenanceReportQueryService.readCurrentAttachmentsForSubmit(
    params.reportId,
    params.transactionContext,
  );
  if (current.length > MAINTENANCE_ATTACHMENT_MAX_COUNT) {
    // 历史多附件行：只读保留，不在本事务内批量退役或隐藏，交由人工逐份处理
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.ATTACHMENT_LIMIT_EXCEEDED,
      '该报告存在多份历史有效附件，需先逐份移除后再更换原件',
      { reportId: params.reportId, currentCount: current.length },
    );
  }
  if (params.mode === 'append' && current.length >= MAINTENANCE_ATTACHMENT_MAX_COUNT) {
    throw new DomainError(
      MAINTENANCE_REPORT_ERROR.ATTACHMENT_LIMIT_EXCEEDED,
      `单份报告最多保留 ${MAINTENANCE_ATTACHMENT_MAX_COUNT} 份有效原件，请先移除现有原件`,
      { reportId: params.reportId, currentCount: current.length },
    );
  }
  if (params.mode === 'replace' && current.length === 1) {
    const existing = current[0];
    if (existing.fileId !== null && existing.fileId === params.attachment.fileId) {
      // 同一原件重复提交（合法重试）：幂等跳过，不重复退役/绑定
      return existing;
    }
    const retired = await maintenanceReportService.retireAttachment(
      params.reportId,
      existing.id,
      new Date(),
      params.transactionContext,
    );
    if (!retired) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.ATTACHMENT_NOT_FOUND,
        '原有效附件不存在或已移除，请刷新后重试',
        { reportId: params.reportId, attachmentId: existing.id },
      );
    }
    if (existing.fileId !== null) {
      // 历史行 file_id 可为 NULL（迁移 49 之前）：此时无 stored_file 事实可解除
      await storedFileService.unbindIfBoundTo(
        {
          fileId: existing.fileId,
          businessType: StoredFileBusinessType.MAINTENANCE_REPORT,
          businessId: String(params.reportId),
        },
        params.transactionContext,
      );
    }
  }
  return bindStagedAttachmentToReport(params);
}
