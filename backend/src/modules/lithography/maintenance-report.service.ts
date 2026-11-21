// src/modules/lithography/maintenance-report.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { randomUUID } from 'node:crypto';
import {
  MAINTENANCE_REPORT_ERROR,
  DomainError,
  REPAIR_REQUEST_ERROR,
} from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { In, ObjectLiteral, Repository } from 'typeorm';
import { MaintenanceReportAlarmEntity } from './entities/maintenance-report-alarm.entity';
import { MaintenanceReportAttachmentEntity } from './entities/maintenance-report-attachment.entity';
import { MaintenanceReportFaultEntity } from './entities/maintenance-report-fault.entity';
import { MaintenanceReportReviewEntity } from './entities/maintenance-report-review.entity';
import { MaintenanceReportStepEntity } from './entities/maintenance-report-step.entity';
import { MaintenanceReportVersionAttachmentEntity } from './entities/maintenance-report-version-attachment.entity';
import { MaintenanceReportVersionEntity } from './entities/maintenance-report-version.entity';
import { MaintenanceReportEntity } from './entities/maintenance-report.entity';
import {
  MaintenanceReportAlarmWriteData,
  MaintenanceReportAttachmentInsertData,
  MaintenanceReportAttachmentSnapshot,
  MaintenanceReportDraftWriteData,
  MaintenanceReportFaultWriteData,
  MaintenanceReportInsertData,
  MaintenanceReportReviewInsertData,
  MaintenanceReportReviewSnapshot,
  MaintenanceReportSnapshot,
  MaintenanceReportStepWriteData,
  MaintenanceReportVersionAttachmentWriteData,
  MaintenanceReportVersionInsertData,
  MaintenanceReportVersionSnapshot,
  RepairRequestWriteContext,
} from './maintenance-report.types';
import {
  faultBranchKindToDb,
  toMaintenanceReportAttachmentSnapshot,
  toMaintenanceReportReviewSnapshot,
  toMaintenanceReportSnapshot,
  toMaintenanceReportVersionSnapshot,
} from './maintenance-report.mapper';
import { RepairRequestEntity } from './entities/repair-request.entity';
import { isDuplicateKeyError } from './database-error.helpers';

/**
 * 维修报告写服务。
 *
 * 职责：
 * - 报告根/报警/步骤/附件/冻结版本/审核记录的细粒度写入；
 * - 状态敏感动作前对报告行加悲观写锁（可编辑性、版本号裁决归 usecase）；
 * - 同一报告内子记录全量覆盖或逐项变更的原子写入。
 *
 * 不包含：
 * - 权限判断、输入规范化、状态裁决、分析结果校验（归 usecase）；
 * - 组织解析（由 usecase 传入可信组织）；
 * - 事务开启（由 usecase 通过 TransactionRunner 持有）。
 */
@Injectable()
export class MaintenanceReportService {
  constructor(
    @InjectRepository(MaintenanceReportEntity)
    private readonly reportRepository: Repository<MaintenanceReportEntity>,
    @InjectRepository(MaintenanceReportAlarmEntity)
    private readonly alarmRepository: Repository<MaintenanceReportAlarmEntity>,
    @InjectRepository(MaintenanceReportStepEntity)
    private readonly stepRepository: Repository<MaintenanceReportStepEntity>,
    @InjectRepository(MaintenanceReportFaultEntity)
    private readonly faultRepository: Repository<MaintenanceReportFaultEntity>,
    @InjectRepository(MaintenanceReportAttachmentEntity)
    private readonly attachmentRepository: Repository<MaintenanceReportAttachmentEntity>,
    @InjectRepository(MaintenanceReportVersionEntity)
    private readonly versionRepository: Repository<MaintenanceReportVersionEntity>,
    @InjectRepository(MaintenanceReportVersionAttachmentEntity)
    private readonly versionAttachmentRepository: Repository<MaintenanceReportVersionAttachmentEntity>,
    @InjectRepository(MaintenanceReportReviewEntity)
    private readonly reviewRepository: Repository<MaintenanceReportReviewEntity>,
    @InjectRepository(RepairRequestEntity)
    private readonly repairRequestRepository: Repository<RepairRequestEntity>,
  ) {}

  async insertReport(
    data: MaintenanceReportInsertData,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<MaintenanceReportSnapshot> {
    const repository = this.getRepository(this.reportRepository, transactionContext);
    try {
      const entity = repository.create({
        ownerOrganizationId: data.ownerOrganizationId,
        sourceType: data.sourceType,
        repairRequestId: data.repairRequestId,
        title: data.title,
        customerFactoryName: data.customerFactoryName,
        equipmentModelId: data.equipmentModelId,
        equipmentModelText: data.equipmentModelText,
        maintenanceDate: data.maintenanceDate,
        maintenanceEngineerAccountId: data.maintenanceEngineerAccountId,
        maintenanceEngineerNameSnapshot: data.maintenanceEngineerNameSnapshot,
        phaseFlowVersion: data.phaseFlowVersion,
        status: 'DRAFT',
        currentVersionNo: 0,
        lastSubmittedAt: null,
        lastReviewedAt: null,
        aiUsage: 'NOT_USED',
        aiSourceType: null,
        aiSourceId: null,
        aiSourceVersion: null,
        aiScore: null,
        aiCorrectness: null,
        aiHelpfulness: null,
        aiNote: null,
        createdByAccountId: data.createdByAccountId,
        updatedByAccountId: data.updatedByAccountId,
        // R051-01 直接提交路径：报告根创建即携带提交标识与摘要，
        // 由 (created_by, owner_org, submission_request_id) 唯一键处理并发竞争；
        // 普通建稿为 NULL，提交标识在 markSubmitted 时统一写入。
        submissionRequestId: data.submissionRequestId ?? null,
        submissionPayloadHash: data.submissionPayloadHash ?? null,
      });
      const saved = await repository.save(entity);
      return toMaintenanceReportSnapshot(saved);
    } catch (error) {
      // 一工单一份总结根的库级兜底：并发预检失效时仍按业务冲突返回，而非系统错误
      if (isDuplicateKeyError(error) && data.repairRequestId !== null) {
        throw new DomainError(
          MAINTENANCE_REPORT_ERROR.WORK_ORDER_ALREADY_SUMMARIZED,
          '该工单已存在维修总结',
          { repairRequestId: data.repairRequestId },
        );
      }
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.CREATION_FAILED,
        '维修报告创建失败，请稍后重试',
        undefined,
        error,
      );
    }
  }

  /** 状态敏感动作前锁定报告行；不存在返回 null */
  async lockReportForWrite(
    reportId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<MaintenanceReportSnapshot | null> {
    const repository = this.getRepository(this.reportRepository, transactionContext);
    const entity = await repository.findOne({
      where: { id: reportId },
      lock: { mode: 'pessimistic_write' },
    });
    return entity ? toMaintenanceReportSnapshot(entity) : null;
  }

  async updateDraft(
    reportId: number,
    data: MaintenanceReportDraftWriteData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.getRepository(this.reportRepository, transactionContext);
    const result = await repository.update(
      { id: reportId },
      {
        title: data.title,
        customerFactoryName: data.customerFactoryName,
        equipmentModelId: data.equipmentModelId,
        equipmentModelText: data.equipmentModelText,
        maintenanceDate: data.maintenanceDate,
        handlingResult: data.handlingResult,
        closureReason: data.closureReason,
        resetResult: data.resetResult,
        actualCause: data.actualCause,
        repairActions: data.repairActions,
        verificationResult: data.verificationResult,
        supplementaryNote: data.supplementaryNote,
        aiUsage: data.aiUsage,
        aiSourceType: data.aiSourceType,
        aiSourceId: data.aiSourceId,
        aiSourceVersion: data.aiSourceVersion,
        aiScore: data.aiScore,
        aiCorrectness: data.aiCorrectness,
        aiHelpfulness: data.aiHelpfulness,
        aiNote: data.aiNote,
        updatedByAccountId: data.updatedByAccountId,
      },
    );
    if (!result.affected) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在');
    }
  }

  async replaceAlarms(
    reportId: number,
    alarms: MaintenanceReportAlarmWriteData[],
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.getRepository(this.alarmRepository, transactionContext);
    await repository.delete({ reportId });
    if (alarms.length === 0) return;
    await repository.insert(
      alarms.map((alarm) => ({
        reportId,
        alarmIndex: alarm.alarmIndex,
        alarmCode: alarm.alarmCode,
        alarmDescription: alarm.alarmDescription,
        phaseCode: alarm.phaseCode,
        resetResult: alarm.resetResult,
      })),
    );
  }

  /**
   * 全量替换排查步骤。
   *
   * 故障分支对步骤有 (report_id, step_code) 复合外键（ON DELETE RESTRICT），
   * 因此删除步骤前必须先删除本报告的故障行；调用方需在步骤写入后重新写入有效故障分支。
   */
  async replaceSteps(
    reportId: number,
    steps: MaintenanceReportStepWriteData[],
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    await this.getRepository(this.faultRepository, transactionContext).delete({ reportId });
    const repository = this.getRepository(this.stepRepository, transactionContext);
    await repository.delete({ reportId });
    if (steps.length === 0) return;
    await repository.insert(
      steps.map((step) => ({
        reportId,
        stepNo: step.stepNo,
        stepCode: step.stepCode,
        phaseCode: step.phaseCode,
        partName: step.partName,
        actionText: step.actionText,
        resultCode: step.resultCode,
        errorCode: step.errorCode,
        resultText: step.resultText,
        newAlarmCode: step.newAlarmCode,
        isValidNewBranch: step.isValidNewBranch,
      })),
    );
  }

  /**
   * 全量替换报告故障分支。
   *
   * 故障行必须晚于步骤写入：STEP_NEW_FAULT 通过 (report_id, step_code)
   * 复合外键指向本次已落库的步骤，删除顺序则为先故障后步骤（由调用方保证步骤
   * 替换发生在故障替换之前）。
   */
  async replaceFaults(
    reportId: number,
    faults: MaintenanceReportFaultWriteData[],
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.getRepository(this.faultRepository, transactionContext);
    await repository.delete({ reportId });
    if (faults.length === 0) return;
    await repository.insert(
      faults.map((fault) => ({
        reportId,
        faultUuid: randomUUID(),
        branchKind: faultBranchKindToDb(fault.branchKind),
        stepCode: fault.stepCode,
        panelSnapshot: null,
        faultDescription: fault.description,
        faultCause: null,
        handlingAction: fault.action,
        mainError: fault.mainError,
        unitError: fault.unitError,
        errorType: fault.errorType,
        gpibStatus: fault.gpibStatus,
        status: fault.faultStatus,
        source: fault.source,
        phaseCode: fault.phaseCode,
        isActive: true,
        lifecycleStatus: 'IN_PROGRESS',
        lifecycleSource: 'USER',
      })),
    );
  }

  async insertAttachment(
    data: MaintenanceReportAttachmentInsertData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<MaintenanceReportAttachmentSnapshot> {
    const repository = this.getRepository(this.attachmentRepository, transactionContext);
    const entity = repository.create({
      ...data,
      status: 'CURRENT',
      retiredAt: null,
    });
    const saved = await repository.save(entity);
    return toMaintenanceReportAttachmentSnapshot(saved);
  }

  async retireAttachment(
    reportId: number,
    attachmentId: number,
    retiredAt: Date,
    transactionContext: PersistenceTransactionContext,
  ): Promise<boolean> {
    const repository = this.getRepository(this.attachmentRepository, transactionContext);
    const result = await repository.update(
      { id: attachmentId, reportId, status: 'CURRENT' },
      { status: 'RETIRED', retiredAt },
    );
    return Boolean(result.affected);
  }

  /**
   * 重排当前附件展示顺序。
   *
   * 当前顺序列受 `(report_id, active_sort_order)` 唯一约束（生成列绑定 CURRENT），
   * 因此采用事务内两段式：先整体临时退役释放槽位，再按目标顺序恢复 CURRENT。
   * 事务回滚时不会留下退役事实。
   */
  async reorderCurrentAttachments(
    reportId: number,
    orderedAttachmentIds: number[],
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.getRepository(this.attachmentRepository, transactionContext);
    const now = new Date();
    await repository.update({ reportId, status: 'CURRENT' }, { status: 'RETIRED', retiredAt: now });
    for (let index = 0; index < orderedAttachmentIds.length; index += 1) {
      const result = await repository.update(
        { id: orderedAttachmentIds[index], reportId, status: 'RETIRED' },
        { status: 'CURRENT', retiredAt: null, sortOrder: index + 1 },
      );
      if (!result.affected) {
        throw new DomainError(MAINTENANCE_REPORT_ERROR.ATTACHMENT_NOT_FOUND, '附件不存在');
      }
    }
  }

  async insertVersion(
    data: MaintenanceReportVersionInsertData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<MaintenanceReportVersionSnapshot> {
    const repository = this.getRepository(this.versionRepository, transactionContext);
    const entity = repository.create({
      reportId: data.reportId,
      versionNo: data.versionNo,
      changeKind: data.changeKind,
      changeReason: data.changeReason,
      schemaVersion: 2,
      payloadSnapshot: data.payloadSnapshot,
      submittedByAccountId: data.submittedByAccountId,
      submittedAt: data.submittedAt,
    });
    const saved = await repository.save(entity);
    return toMaintenanceReportVersionSnapshot(saved);
  }

  async insertVersionAttachments(
    versionId: number,
    reportId: number,
    attachments: MaintenanceReportVersionAttachmentWriteData[],
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    if (attachments.length === 0) return;
    const repository = this.getRepository(this.versionAttachmentRepository, transactionContext);
    await repository.insert(
      attachments.map((attachment) => ({
        versionId,
        reportId,
        attachmentId: attachment.attachmentId,
        sortOrder: attachment.sortOrder,
        descriptionSnapshot: attachment.descriptionSnapshot,
        publishFlag: false,
      })),
    );
  }

  async markPendingReview(
    reportId: number,
    versionNo: number,
    submittedAt: Date,
    updatedByAccountId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    await this.updateStatus(reportId, transactionContext, {
      status: 'PENDING_REVIEW',
      currentVersionNo: versionNo,
      lastSubmittedAt: submittedAt,
      lastReviewedAt: null,
      updatedByAccountId,
    });
  }

  /**
   * R051-01 正式提交：条件更新 DRAFT/RETURNED → SUBMITTED 并写入提交标识与摘要。
   *
   * 条件更新保证「同一份报告只完成一次 DRAFT→SUBMITTED」：
   * 已 SUBMITTED 的报告（含并发第二次到达）affected = 0，由调用方裁决为幂等返回或冲突。
   * 提交标识重复命中 uk_maintenance_report_submission 时抛出重复键错误，
   * 由调用方按「定位既有结果 / 拒绝同标识异内容」处理。
   */
  async markSubmitted(
    reportId: number,
    versionNo: number,
    submittedAt: Date,
    updatedByAccountId: number,
    submissionRequestId: string,
    submissionPayloadHash: string,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.getRepository(this.reportRepository, transactionContext);
    const result = await repository.update(
      {
        id: reportId,
        status: In(['DRAFT', 'RETURNED'] as const),
      },
      {
        status: 'SUBMITTED',
        currentVersionNo: versionNo,
        lastSubmittedAt: submittedAt,
        lastReviewedAt: null,
        submissionRequestId,
        submissionPayloadHash,
        updatedByAccountId,
      },
    );
    if (!result.affected) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.STATE_NOT_EDITABLE,
        '当前状态下的维修报告不可正式提交',
        { reportId },
      );
    }
  }

  async markReturned(
    reportId: number,
    reviewedAt: Date,
    updatedByAccountId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    await this.updateStatus(reportId, transactionContext, {
      status: 'RETURNED',
      lastReviewedAt: reviewedAt,
      updatedByAccountId,
    });
  }

  async markApproved(
    reportId: number,
    reviewedAt: Date,
    updatedByAccountId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    await this.updateStatus(reportId, transactionContext, {
      status: 'APPROVED',
      lastReviewedAt: reviewedAt,
      updatedByAccountId,
    });
  }

  async insertReview(
    data: MaintenanceReportReviewInsertData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<MaintenanceReportReviewSnapshot> {
    const repository = this.getRepository(this.reviewRepository, transactionContext);
    const entity = repository.create({
      reportId: data.reportId,
      versionId: data.versionId,
      decision: data.decision,
      comment: data.comment,
      reviewedByAccountId: data.reviewedByAccountId,
      reviewedAt: data.reviewedAt,
    });
    const saved = await repository.save(entity);
    return toMaintenanceReportReviewSnapshot(saved);
  }

  async publishVersionAttachments(
    versionId: number,
    reportId: number,
    attachmentIds: number[],
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.getRepository(this.versionAttachmentRepository, transactionContext);
    const current = await repository.find({ where: { versionId, reportId } });
    if (
      hasUnknownAttachmentId(
        attachmentIds,
        current.map((row) => row.attachmentId),
      )
    ) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.ATTACHMENT_NOT_FOUND,
        '发布选择包含不属于该冻结版本的附件',
      );
    }
    if (attachmentIds.length === 0) return;
    const result = await repository.update(
      { versionId, reportId, attachmentId: In(attachmentIds) },
      { publishFlag: true },
    );
    if (!result.affected) {
      throw new DomainError(
        MAINTENANCE_REPORT_ERROR.ATTACHMENT_NOT_FOUND,
        '发布选择包含不属于该冻结版本的附件',
      );
    }
  }

  /** 读取工单最小写事实（用于总结前置校验与处理结果写入） */
  async readRepairRequestWriteContext(
    repairRequestId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<RepairRequestWriteContext | null> {
    const repository = this.getRepository(this.repairRequestRepository, transactionContext);
    const entity = await repository.findOne({
      where: { id: repairRequestId },
      lock: { mode: 'pessimistic_write' },
    });
    return entity ? toRepairRequestWriteContext(entity) : null;
  }

  /**
   * 只读工单最小事实（入口资格判定用，不取行锁）。
   *
   * 写路径必须继续使用 `readRepairRequestWriteContext` 的锁定读；
   * 本方法只服务「打开总结入口」这类不改变状态的读取。
   */
  async findRepairRequestWriteContext(
    repairRequestId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<RepairRequestWriteContext | null> {
    const repository = this.getRepository(this.repairRequestRepository, transactionContext);
    const entity = await repository.findOne({ where: { id: repairRequestId } });
    return entity ? toRepairRequestWriteContext(entity) : null;
  }

  /**
   * 原子写入工单处理结果（状态由调用方按固定映射传入）。
   *
   * WHERE 中带上归属与接单人条件：调用方已持有工单行锁，这里再做一次条件收窄，
   * 避免锁期间归属事实变化或调用方遗漏校验时改写他人/他组织工单。
   */
  async updateRepairRequestHandling(
    repairRequestId: number,
    data: {
      handlingResult: string;
      handlingStatus: string;
      handlingRecordedAt: Date;
      handlingRecordedByAccountId: number;
      handlingEndedAt: Date | null;
      /** 中断/无法修复原因；由用例层校验，服务层只负责原子写入 */
      closureReason: string | null;
    },
    ownershipGuard: {
      ownerOrganizationId: number;
      acceptedEngineerAccountId: number;
    },
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.getRepository(this.repairRequestRepository, transactionContext);
    try {
      const result = await repository.update(
        {
          id: repairRequestId,
          deprecated: false,
          isAccepted: true,
          ownerOrganizationId: ownershipGuard.ownerOrganizationId,
          acceptedByEngineerAccountId: ownershipGuard.acceptedEngineerAccountId,
        },
        data,
      );
      if (!result.affected) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.HANDLING_NOT_AVAILABLE,
          '工单当前不可记录处理结果',
        );
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        REPAIR_REQUEST_ERROR.HANDLING_UPDATE_FAILED,
        '处理结果保存失败，请稍后重试',
        undefined,
        error,
      );
    }
  }

  private async updateStatus(
    reportId: number,
    transactionContext: PersistenceTransactionContext,
    data: Partial<MaintenanceReportEntity>,
  ): Promise<void> {
    const repository = this.getRepository(this.reportRepository, transactionContext);
    const result = await repository.update({ id: reportId }, data);
    if (!result.affected) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在');
    }
  }

  private getRepository<T extends ObjectLiteral>(
    repository: Repository<T>,
    transactionContext?: PersistenceTransactionContext,
  ): Repository<T> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    if (!manager) return repository;
    return manager.getRepository(repository.target);
  }
}

function hasUnknownAttachmentId(requested: number[], allowed: number[]): boolean {
  const allowedSet = new Set(allowed);
  return requested.some((id) => !allowedSet.has(id));
}

function toRepairRequestWriteContext(entity: RepairRequestEntity): RepairRequestWriteContext {
  return {
    id: entity.id,
    requestNo: entity.requestNo,
    customerAccountId: entity.customerAccountId,
    equipmentModelId: entity.equipmentModelId,
    acceptedEngineerAccountId: entity.acceptedByEngineerAccountId,
    isAccepted: entity.isAccepted,
    deprecated: entity.deprecated,
    ownerOrganizationId: entity.ownerOrganizationId ?? null,
    closureStatus: entity.closureStatus ?? null,
    closedAt: entity.closedAt ?? null,
    handlingResult: entity.handlingResult ?? null,
    handlingStatus: entity.handlingStatus ?? null,
    closureReason: entity.closureReason ?? null,
    customerOrganizationId: entity.customerOrganizationId ?? null,
    currentRevisionNo: entity.currentRevisionNo,
  };
}
