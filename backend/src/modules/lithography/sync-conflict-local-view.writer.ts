// src/modules/lithography/sync-conflict-local-view.writer.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type {
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import { SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import {
  isTerminalHandlingStatus,
  resolveRepairRequestHandlingStatus,
} from '@core/repair-request/policy/repair-request-handling.policy';
import {
  REPAIR_REQUEST_REVISION_SCHEMA_VERSION,
  buildRepairRequestRevisionSnapshot,
  type RepairRequestRevisionSnapshotPanel,
  type RepairRequestRevisionSnapshotRequest,
  type RepairRequestRevisionSnapshotStep,
} from '@core/repair-request/policy/repair-request-revision.policy';
import { requiresClosureReason } from '@core/repair-request/policy/repair-process-write.policy';
import { Injectable } from '@nestjs/common';
import type {
  RepairMaintenanceFaultPanelView,
  RepairMaintenanceStepView,
} from '@src/modules/lithography/lithography.types';
import type {
  SyncConflictLocalViewWriteCommand,
  SyncConflictLocalViewWriteOutcome,
  SyncConflictLocalViewWriter,
} from '@usecases/common/ports/sync-conflict-local-view-writer.contract';
import { ReferenceDocumentEffectiveContentService } from './reference-document-effective-content.service';
import { buildReferenceDocumentRevisionSnapshot } from './reference-document-revision-snapshot';
import { ReferenceDocumentRevisionService } from './reference-document-revision.service';
import {
  RepairRequestRevisionService,
  type RepairRequestRevisionTargetSnapshot,
} from './repair-request-revision.service';

/**
 * 「使用云端」的本地视图对齐写入（任务 09 R068）。
 *
 * 由**来源域**注册实现（中立端口 `SYNC_CONFLICT_LOCAL_VIEW_WRITER`）：
 * 冲突编排（本地运行域）只负责"能不能对齐"的裁决与事务边界，
 * 真正的**业务行写入**由这里按来源业务的受控入口完成——
 * 与恢复链同一条纪律："实现方不得绕过来源域的受控入口直接写业务表"。
 *
 * 写入语义（R068）：
 * - 只写**受控白名单字段**：
 *   - 工单：正文 `content_md` ＋ 处理结果／处理状态；
 *   - 资料：标题 `title`、说明 `description`、资料自身正文 `content_text`
 *     （**不含**文档类型、原件名、MIME 与扩展名——那是结构与原件身份，
 *     云端原件不得覆盖本地原件登记）；
 * - 客户原始提交、接单事实、组织归属、状态机事实、结构化维修记录一律不动；
 * - **版本条件**：`expectedVersion` 必须等于工单当前 `current_revision_no`，
 *   条件更新命中 0 行即版本冲突（不覆盖别人的推进）；
 * - **历史只追加**：写一条新的修订历史行（前后完整快照＋修改人＋原因），
 *   原本地历史不被覆盖；
 * - **不产生多余版本**：云端内容与本地已经一致时不写任何东西；
 * - 采纳者**不因此获得编辑权**：这里写的是"本地视图对齐到云端"，
 *   不是把采纳者当成工单的处理人（见下"处理事实的归属口径"）。
 *
 * 处理事实的归属口径：本地视图对齐到云端的处理结果时，
 * 本地**处理事实时间与记录人**记为"采用者在采用时刻登记本地视图"，
 * 原本的处理归属保留在修订历史的**前快照**里；不冒充原处理人。
 */
@Injectable()
export class SyncConflictLocalViewWriterService implements SyncConflictLocalViewWriter {
  readonly supportedResourceTypes: readonly string[] = ['REPAIR_REQUEST', 'REFERENCE_DOCUMENT'];

  constructor(
    private readonly revisionService: RepairRequestRevisionService,
    private readonly documentRevisionService: ReferenceDocumentRevisionService,
    private readonly documentEffectiveContentService: ReferenceDocumentEffectiveContentService,
  ) {}

  async alignLocalViewToCloud(
    command: SyncConflictLocalViewWriteCommand,
    transactionContext: PersistenceTransactionContext,
  ): Promise<SyncConflictLocalViewWriteOutcome> {
    const payload = command.payload;
    if (payload.resourceType === 'REFERENCE_DOCUMENT') {
      return this.alignReferenceDocument(command, payload, transactionContext);
    }
    if (payload.resourceType !== 'REPAIR_REQUEST') {
      throw new DomainError(
        SYNC_ERROR.CLOUD_ALIGNMENT_RESOURCE_UNSUPPORTED,
        '该资源类型还没有受控的本地视图对齐入口',
      );
    }
    return this.alignRepairRequest(command, payload, transactionContext);
  }

  /**
   * 工单对齐：按版本条件把云端正文与处理事实落到本地当前视图。
   */
  private async alignRepairRequest(
    command: SyncConflictLocalViewWriteCommand,
    payload: Extract<
      SyncConflictLocalViewWriteCommand['payload'],
      { resourceType: 'REPAIR_REQUEST' }
    >,
    transactionContext: PersistenceTransactionContext,
  ): Promise<SyncConflictLocalViewWriteOutcome> {
    const target = await this.revisionService.lockRequestForRevision(
      command.recordId,
      transactionContext,
    );
    if (target === null || target.deprecated) {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_NOT_FOUND,
        '同步冲突的来源记录不存在或不可用，不能对齐本地视图',
      );
    }
    if (target.currentRevisionNo !== payload.expectedVersion) {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_VERSION_STALE,
        '来源记录已被别处推进，请刷新后重新裁决',
      );
    }

    const now = new Date();
    const next = resolveNextView(target, payload, command.actorAccountId, now);
    if (!next.changed) {
      // 云端内容与本地已经一致：不产生多余业务版本（R068）
      return { aligned: false, alignedVersion: target.currentRevisionNo };
    }

    const processEntries = await this.revisionService.lockProcessEntriesForRevision(
      command.recordId,
      transactionContext,
    );
    const responses = await this.revisionService.listResponsesForSnapshot(
      command.recordId,
      transactionContext,
    );
    const maintenanceSteps = await this.revisionService.lockMaintenanceSteps(
      command.recordId,
      transactionContext,
    );
    const maintenanceFaultPanels = await this.revisionService.lockMaintenancePanels(
      command.recordId,
      transactionContext,
    );

    const beforeSnapshot = buildRepairRequestRevisionSnapshot({
      request: toSnapshotRequest(target),
      processEntries,
      responses,
      maintenanceSteps: maintenanceSteps.map(toSnapshotStep),
      maintenanceFaultPanels: maintenanceFaultPanels.map(toSnapshotPanel),
    });

    const affected = await this.revisionService.updateRequestRevisionFields(
      {
        requestId: command.recordId,
        expectedVersion: payload.expectedVersion,
        nextVersion: target.currentRevisionNo + 1,
        contentMd: next.contentMd,
        handlingResult: next.handlingResult,
        handlingStatus: next.handlingStatus,
        handlingRecordedAt: next.handlingRecordedAt,
        handlingRecordedByAccountId: next.handlingRecordedByAccountId,
        handlingEndedAt: next.handlingEndedAt,
      },
      transactionContext,
    );
    if (affected !== 1) {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_VERSION_STALE,
        '来源记录已被别处推进，请刷新后重新裁决',
      );
    }

    const afterSnapshot = buildRepairRequestRevisionSnapshot({
      request: next.requestSnapshot,
      processEntries,
      responses,
      maintenanceSteps: maintenanceSteps.map(toSnapshotStep),
      maintenanceFaultPanels: maintenanceFaultPanels.map(toSnapshotPanel),
    });
    await this.revisionService.insertRevision(
      {
        requestId: command.recordId,
        revisionNo: target.currentRevisionNo + 1,
        previousVersion: payload.expectedVersion,
        beforeSnapshot: JSON.stringify(beforeSnapshot),
        afterSnapshot: JSON.stringify(afterSnapshot),
        schemaVersion: REPAIR_REQUEST_REVISION_SCHEMA_VERSION,
        actorAccountId: command.actorAccountId,
        reason: command.reason,
      },
      transactionContext,
    );

    return { aligned: true, alignedVersion: target.currentRevisionNo + 1 };
  }

  /**
   * 资料对齐：按版本条件把云端标题／说明／资料自身正文落到本地当前视图。
   *
   * 与工单同口径：
   * - 版本条件命中才写（`advanceCurrentRevision` 的 WHERE 带 `current_revision_no`）；
   * - 历史只追加（写一条新的修订行，原本地历史不动）；
   * - 内容已一致时不写（不产生多余业务版本）；
   * - 只读来源（下架／归属待确认）不得反写。
   *
   * 快照必须携带**当时生效正文**（管理修订 > 冻结报告 > 资料自身正文），
   * 否则对齐后读侧会回退到"资料自身正文"而丢掉冻结报告正文。
   */
  private async alignReferenceDocument(
    command: SyncConflictLocalViewWriteCommand,
    payload: Extract<
      SyncConflictLocalViewWriteCommand['payload'],
      { resourceType: 'REFERENCE_DOCUMENT' }
    >,
    transactionContext: PersistenceTransactionContext,
  ): Promise<SyncConflictLocalViewWriteOutcome> {
    const target = await this.documentRevisionService.lockDocumentForRevision(
      command.recordId,
      transactionContext,
    );
    if (target === null || target.deprecated) {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_NOT_FOUND,
        '同步冲突的来源记录不存在或不可用，不能对齐本地视图',
      );
    }
    // 只读来源不得反写：下架（撤回）与归属待确认（冻结）一律拒绝
    if (target.publicationStatus === 'OFFLINE') {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_SOURCE_READ_ONLY,
        '来源记录已删除或下架，不得用云端版本恢复内容',
      );
    }
    if (target.ownershipStatus === 'PENDING') {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_SOURCE_READ_ONLY,
        '来源记录正在被别处推进（冻结），不得用云端版本恢复内容',
      );
    }
    if (target.currentRevisionNo !== payload.expectedVersion) {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_VERSION_STALE,
        '来源记录已被别处推进，请刷新后重新裁决',
      );
    }

    const nextTitle = payload.title ?? target.title;
    const nextDescription = payload.description ?? target.description;
    const nextContentText = payload.contentText ?? target.contentText;
    const changed =
      nextTitle !== target.title ||
      nextDescription !== target.description ||
      nextContentText !== target.contentText;
    if (!changed) {
      // 云端内容与本地已经一致：不产生多余业务版本（R068）
      return { aligned: false, alignedVersion: target.currentRevisionNo };
    }

    // 对齐前的生效正文（写进 before 快照）：修订行／冻结版本行缺失即失败关闭，
    // 不回退资料自身正文冒充历史
    const beforeContentText =
      await this.documentEffectiveContentService.resolveEffectiveContentText({
        documentId: target.id,
        effectiveRevisionNo: target.currentRevisionNo,
        sourceKind: target.sourceKind,
        sourceReportId: target.sourceReportId,
        sourceReportVersionId: target.sourceReportVersionId,
        contentText: target.contentText,
        transactionContext,
      });
    // 对齐后的生效正文：正文列被云端内容覆盖时随之变化；
    // 只改标题／说明时正文沿用对齐前的生效正文（不因一次标题对齐丢掉冻结报告正文）
    const afterContentText =
      payload.contentText !== null && payload.contentText !== undefined
        ? payload.contentText
        : beforeContentText;

    const nextRevisionNo = target.currentRevisionNo + 1;
    const beforeSnapshot = buildReferenceDocumentRevisionSnapshot({
      schemaVersion: target.schemaVersion,
      title: target.title,
      documentType: target.documentType,
      description: target.description,
      contentText: beforeContentText,
      publicationStatus: target.publicationStatus,
      ownershipStatus: target.ownershipStatus,
      createdByAccountId: target.createdByAccountId,
      ownerOrganizationId: target.ownerOrganizationId,
    });
    const afterSnapshot = buildReferenceDocumentRevisionSnapshot({
      schemaVersion: target.schemaVersion,
      title: nextTitle,
      documentType: target.documentType,
      description: nextDescription,
      contentText: afterContentText,
      publicationStatus: target.publicationStatus,
      ownershipStatus: target.ownershipStatus,
      createdByAccountId: target.createdByAccountId,
      ownerOrganizationId: target.ownerOrganizationId,
    });

    const outcome = await this.documentRevisionService.advanceCurrentRevision(
      {
        documentId: command.recordId,
        expectedRevisionNo: payload.expectedVersion,
        apply: {
          title: nextTitle,
          description: nextDescription,
          contentText: nextContentText,
          updatedByAccountId: command.actorAccountId,
        },
      },
      transactionContext,
    );
    if (outcome === 'VERSION_CONFLICT') {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_VERSION_STALE,
        '来源记录已被别处推进，请刷新后重新裁决',
      );
    }
    if (outcome !== 'ADVANCED') {
      throw new DomainError(
        SYNC_ERROR.CONFLICT_NOT_FOUND,
        '同步冲突的来源记录不存在或不可用，不能对齐本地视图',
      );
    }

    await this.documentRevisionService.insertRevision(
      {
        documentId: command.recordId,
        revisionNo: nextRevisionNo,
        beforeSnapshot: JSON.stringify(beforeSnapshot),
        afterSnapshot: JSON.stringify(afterSnapshot),
        actorAccountId: command.actorAccountId,
        reason: command.reason,
      },
      transactionContext,
    );

    return { aligned: true, alignedVersion: nextRevisionNo };
  }
}

type NextView = {
  changed: boolean;
  contentMd: string;
  handlingResult: RepairRequestHandlingResult | undefined;
  handlingStatus: RepairRequestHandlingStatus | undefined;
  handlingRecordedAt: Date | undefined;
  handlingRecordedByAccountId: number | undefined;
  handlingEndedAt: Date | null | undefined;
  requestSnapshot: RepairRequestRevisionSnapshotRequest;
};

/**
 * 计算对齐后的下一版本内容（纯函数）。
 *
 * 失败关闭：本地事实不足以承载云端内容时直接拒绝，不猜、不补。
 */
function resolveNextView(
  target: RepairRequestRevisionTargetSnapshot,
  payload: Extract<
    SyncConflictLocalViewWriteCommand['payload'],
    { resourceType: 'REPAIR_REQUEST' }
  >,
  actorAccountId: number,
  now: Date,
): NextView {
  const contentMd = payload.contentMd ?? target.contentMd;

  let handlingResult: RepairRequestHandlingResult | undefined;
  let handlingStatus: RepairRequestHandlingStatus | undefined;
  let handlingRecordedAt: Date | undefined;
  let handlingRecordedByAccountId: number | undefined;
  let handlingEndedAt: Date | null | undefined;

  const nextResult = payload.handlingResult;
  if (nextResult !== null && nextResult !== target.handlingResult) {
    // 处理结果变化 ⇒ 需要落处理事实（库级 CHECK：结果非空则记录时间非空）
    if (!target.isAccepted) {
      throw new DomainError(
        SYNC_ERROR.CLOUD_ALIGNMENT_FAILED,
        '本地工单尚未接单，无法对齐云端处理结果',
      );
    }
    const nextStatus = payload.handlingStatus ?? resolveRepairRequestHandlingStatus(nextResult);
    if (requiresClosureReason(nextResult) && !hasClosureReasonText(target.closureReason)) {
      throw new DomainError(
        SYNC_ERROR.CLOUD_ALIGNMENT_FAILED,
        '云端处理结果需要结单原因，本地没有可沿用的原因，不能凭空补写',
      );
    }
    handlingResult = nextResult;
    handlingStatus = nextStatus;
    handlingRecordedAt = now;
    handlingRecordedByAccountId = actorAccountId;
    handlingEndedAt = isTerminalHandlingStatus(nextStatus) ? (target.handlingEndedAt ?? now) : null;
  }

  const changed = contentMd !== target.contentMd || handlingResult !== undefined;

  const requestSnapshot: RepairRequestRevisionSnapshotRequest = {
    requestNo: target.requestNo,
    customerAccountId: target.customerAccountId,
    equipmentModelId: target.equipmentModelId,
    errorCode: target.errorCode,
    faultDescription: target.faultDescription,
    contentMd,
    createdAt: target.createdAt,
    isAccepted: target.isAccepted,
    acceptedByEngineerAccountId: target.acceptedByEngineerAccountId,
    acceptedAt: target.acceptedAt,
    ownerOrganizationId: target.ownerOrganizationId,
    serviceOrganizationId: target.serviceOrganizationId,
    handlingResult: handlingResult ?? target.handlingResult,
    handlingStatus: handlingStatus ?? target.handlingStatus,
    handlingRecordedAt: handlingRecordedAt ?? target.handlingRecordedAt,
    handlingRecordedByAccountId: handlingRecordedByAccountId ?? target.handlingRecordedByAccountId,
    handlingEndedAt: handlingEndedAt === undefined ? target.handlingEndedAt : handlingEndedAt,
    closureStatus: target.closureStatus,
    closedAt: target.closedAt,
    closureReason: target.closureReason,
    currentRevisionNo: target.currentRevisionNo + (changed ? 1 : 0),
    maintenanceDate: target.maintenanceDate,
    maintenanceEngineerName: target.maintenanceEngineerName,
    resetResult: target.resetResult,
    supplementaryNote: target.supplementaryNote,
    maintenanceVersionNo: target.maintenanceVersionNo,
    maintenanceAttachmentFileId: target.maintenanceAttachmentFileId,
  };

  return {
    changed,
    contentMd,
    handlingResult,
    handlingStatus,
    handlingRecordedAt,
    handlingRecordedByAccountId,
    handlingEndedAt,
    requestSnapshot,
  };
}

function hasClosureReasonText(value: string | null): boolean {
  return value !== null && value.trim() !== '';
}

function toSnapshotRequest(
  target: RepairRequestRevisionTargetSnapshot,
): RepairRequestRevisionSnapshotRequest {
  return {
    requestNo: target.requestNo,
    customerAccountId: target.customerAccountId,
    equipmentModelId: target.equipmentModelId,
    errorCode: target.errorCode,
    faultDescription: target.faultDescription,
    contentMd: target.contentMd,
    createdAt: target.createdAt,
    isAccepted: target.isAccepted,
    acceptedByEngineerAccountId: target.acceptedByEngineerAccountId,
    acceptedAt: target.acceptedAt,
    ownerOrganizationId: target.ownerOrganizationId,
    serviceOrganizationId: target.serviceOrganizationId,
    handlingResult: target.handlingResult,
    handlingStatus: target.handlingStatus,
    handlingRecordedAt: target.handlingRecordedAt,
    handlingRecordedByAccountId: target.handlingRecordedByAccountId,
    handlingEndedAt: target.handlingEndedAt,
    closureStatus: target.closureStatus,
    closedAt: target.closedAt,
    closureReason: target.closureReason,
    currentRevisionNo: target.currentRevisionNo,
    maintenanceDate: target.maintenanceDate,
    maintenanceEngineerName: target.maintenanceEngineerName,
    resetResult: target.resetResult,
    supplementaryNote: target.supplementaryNote,
    maintenanceVersionNo: target.maintenanceVersionNo,
    maintenanceAttachmentFileId: target.maintenanceAttachmentFileId,
  };
}

function toSnapshotStep(step: RepairMaintenanceStepView): RepairRequestRevisionSnapshotStep {
  return { ...step };
}

function toSnapshotPanel(
  panel: RepairMaintenanceFaultPanelView,
): RepairRequestRevisionSnapshotPanel {
  return { ...panel };
}
