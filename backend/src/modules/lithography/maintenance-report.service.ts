// src/modules/lithography/maintenance-report.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
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

  async replaceSteps(
    reportId: number,
    steps: MaintenanceReportStepWriteData[],
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
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
        resultText: step.resultText,
        newAlarmCode: step.newAlarmCode,
        isValidNewBranch: step.isValidNewBranch,
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
    if (!entity) return null;
    return {
      id: entity.id,
      customerAccountId: entity.customerAccountId,
      acceptedEngineerAccountId: entity.acceptedByEngineerAccountId,
      isAccepted: entity.isAccepted,
      deprecated: entity.deprecated,
      ownerOrganizationId: entity.ownerOrganizationId ?? null,
      handlingResult: entity.handlingResult ?? null,
      handlingStatus: entity.handlingStatus ?? null,
    };
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
