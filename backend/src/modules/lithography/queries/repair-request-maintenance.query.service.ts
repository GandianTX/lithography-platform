// src/modules/lithography/queries/repair-request-maintenance.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  StoredFileBindingStatus,
  StoredFileBusinessType,
  StoredFileStatus,
} from '@app-types/models/stored-file.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';
import { IntakeAnalysisAttemptEntity } from '../entities/intake-analysis-attempt.entity';
import { RepairRequestDiagnosticStepEntity } from '../entities/repair-request-diagnostic-step.entity';
import { RepairRequestFaultPanelEntity } from '../entities/repair-request-fault-panel.entity';
import { RepairRequestIntakeEntity } from '../entities/repair-request-intake.entity';
import { RepairRequestEntity } from '../entities/repair-request.entity';
import { StoredFileEntity } from '../entities/stored-file.entity';
import {
  RepairIntakeSourceView,
  RepairMaintenanceAttachmentView,
  RepairMaintenanceFaultPanelView,
  RepairMaintenanceRecordView,
  RepairMaintenanceStepView,
} from '../lithography.types';

/**
 * 结构化维修记录只读查询服务。
 *
 * 职责：
 * - 读取工单自己的维修字段、步骤、故障面板与已绑定维修原件的安全投影；
 * - 读取客户原始报修与首次 AI 分析（仅工程师/管理员入口调用）。
 *
 * 安全边界：
 * - 不返回存储引用、上传者/公司账号 ID；
 * - 维修原件仅在任务 11 绑定事实（用途 REPAIR_PROCESS、VALID、已验证、BOUND、
 *   businessId 指向当前工单）全部满足时才返回，否则连同 fileId 一并隐藏；
 * - 客户入口不得调用本服务读取内部维修或 AI 分析。
 */
@Injectable()
export class RepairRequestMaintenanceQueryService {
  constructor(
    @InjectRepository(RepairRequestEntity)
    private readonly requestRepository: Repository<RepairRequestEntity>,
    @InjectRepository(RepairRequestDiagnosticStepEntity)
    private readonly stepRepository: Repository<RepairRequestDiagnosticStepEntity>,
    @InjectRepository(RepairRequestFaultPanelEntity)
    private readonly panelRepository: Repository<RepairRequestFaultPanelEntity>,
  ) {}

  async findRecord(
    requestId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<RepairMaintenanceRecordView | null> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    const entity = await (
      manager ? manager.getRepository(RepairRequestEntity) : this.requestRepository
    ).findOne({ where: { id: requestId } });
    if (!entity) {
      return null;
    }
    return {
      maintenanceDate: normalizeDateValue(entity.maintenanceDate),
      engineerName: entity.maintenanceEngineerNameSnapshot,
      resetResult: entity.resetResult,
      supplementaryNote: entity.supplementaryNote,
      versionNo: entity.maintenanceVersionNo,
      attachment: await this.resolveAttachment(
        entity.id,
        entity.maintenanceAttachmentFileId,
        transactionContext,
      ),
    };
  }

  async listSteps(
    requestId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<RepairMaintenanceStepView[]> {
    const repository = transactionContext
      ? getTypeOrmEntityManager(transactionContext).getRepository(RepairRequestDiagnosticStepEntity)
      : this.stepRepository;
    const rows = await repository.find({
      where: { requestId },
      order: { stepNo: 'ASC', id: 'ASC' },
    });
    return rows.map((row) => ({
      id: String(row.id),
      stepNo: row.stepNo,
      errorCode: row.errorCode,
      partName: row.partName,
      actionText: row.actionText,
      resultCode: row.resultCode,
    }));
  }

  async listFaultPanels(
    requestId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<RepairMaintenanceFaultPanelView[]> {
    const repository = transactionContext
      ? getTypeOrmEntityManager(transactionContext).getRepository(RepairRequestFaultPanelEntity)
      : this.panelRepository;
    const rows = await repository.find({
      where: { requestId },
      order: { id: 'ASC' },
    });
    return rows.map((row) => ({
      id: String(row.id),
      panelType: row.panelType,
      stepId: row.stepId,
      phaseCode: row.phaseCode,
      mainError: row.mainError,
      unitError: row.unitError,
      source: row.source,
      errorType: row.errorType,
      gpibStatus: row.gpibStatus,
      faultStatus: row.faultStatus,
      description: row.description,
      action: row.action,
    }));
  }

  /**
   * 客户原始报修 + 首次分析。
   * - 只按 intake_id 精确定位，不通过客户/公司/接单人兜底；
   * - 分析原文读取当前 analysis_generation 对应的尝试记录；无尝试记录时 analysis 为 null；
   * - AI 未完成或失败不影响本方法返回，仅如实反映尝试状态。
   */
  async findIntakeSource(requestId: number): Promise<RepairIntakeSourceView | null> {
    const request = await this.requestRepository.findOne({
      where: { id: requestId },
      select: { id: true, intakeId: true },
    });
    if (!request || request.intakeId === null) {
      return null;
    }
    const intake = await this.requestRepository.manager
      .getRepository(RepairRequestIntakeEntity)
      .findOne({ where: { id: request.intakeId } });
    if (!intake) {
      return null;
    }
    const attempt = await this.requestRepository.manager
      .getRepository(IntakeAnalysisAttemptEntity)
      .findOne({ where: { intakeId: intake.id, generationNo: intake.analysisGeneration } });
    return {
      intakeId: intake.id,
      faultDescription: intake.faultDescription,
      customerFile: intake.fileId === null ? null : await this.resolveIntakeFile(intake),
      analysis: attempt
        ? {
            status: attempt.status,
            generation: attempt.generationNo,
            outputText: attempt.outputText,
            failureReason: attempt.failureReason,
            finishedAt: attempt.finishedAt,
          }
        : null,
    };
  }

  private async resolveAttachment(
    requestId: number,
    fileId: string | null,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<RepairMaintenanceAttachmentView | null> {
    if (fileId === null) {
      return null;
    }
    const manager = transactionContext
      ? getTypeOrmEntityManager(transactionContext)
      : this.requestRepository.manager;
    const file = await manager.getRepository(StoredFileEntity).findOne({ where: { fileId } });
    if (!canExposeMaintenanceFile(requestId, fileId, file) || file === null) {
      return null;
    }
    return toAttachmentView(file);
  }

  private async resolveIntakeFile(
    intake: RepairRequestIntakeEntity,
  ): Promise<RepairMaintenanceAttachmentView | null> {
    if (intake.fileId === null) {
      return null;
    }
    const file = await this.requestRepository.manager
      .getRepository(StoredFileEntity)
      .findOne({ where: { fileId: intake.fileId } });
    // 报修原件的 business_type 由任务 03 定义；此处只按 file_id 绑定关系与校验状态投影
    if (
      file === null ||
      (file.status as StoredFileStatus) !== StoredFileStatus.VALID ||
      file.verifiedAt === null
    ) {
      return null;
    }
    if (file.businessId !== null && file.businessId !== String(intake.id)) {
      return null;
    }
    return toAttachmentView(file);
  }
}

function canExposeMaintenanceFile(
  requestId: number,
  expectedFileId: string,
  file: StoredFileEntity | null,
): boolean {
  if (file === null || file.fileId !== expectedFileId) {
    return false;
  }
  if ((file.businessType as StoredFileBusinessType) !== StoredFileBusinessType.REPAIR_PROCESS) {
    return false;
  }
  if ((file.status as StoredFileStatus) !== StoredFileStatus.VALID || file.verifiedAt === null) {
    return false;
  }
  if (
    (file.bindingStatus as StoredFileBindingStatus) !== StoredFileBindingStatus.BOUND ||
    file.businessId === null
  ) {
    return false;
  }
  const businessRequestId = Number(file.businessId);
  return Number.isSafeInteger(businessRequestId) && businessRequestId === requestId;
}

function toAttachmentView(file: StoredFileEntity): RepairMaintenanceAttachmentView {
  return {
    fileId: file.fileId,
    originalFilename: file.originalFilename,
    mimeType: file.mimeType,
    byteSize: Number(file.byteSize),
    checksumSha256: file.checksumSha256,
  };
}

function normalizeDateValue(value: string | Date | null): string | null {
  if (value === null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return value.slice(0, 10);
}
