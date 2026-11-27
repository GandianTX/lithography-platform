// src/modules/lithography/repair-request-maintenance.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { RepairRequestDiagnosticStepEntity } from './entities/repair-request-diagnostic-step.entity';
import { RepairRequestFaultPanelEntity } from './entities/repair-request-fault-panel.entity';
import { RepairRequestIntakeEntity } from './entities/repair-request-intake.entity';
import { RepairRequestEntity } from './entities/repair-request.entity';
import {
  RepairMaintenanceSaveData,
  RepairRequestMaintenanceTargetSnapshot,
} from './lithography.types';

/** 调序时先整体挪到高位，避开 (request_id, step_no) 唯一约束的瞬时冲突 */
const STEP_NO_OFFSET = 1_000_000;

/**
 * 工单结构化内部维修记录读写服务。
 *
 * 边界：
 * - 只读写工单自己的 maintenance_* 字段与步骤/面板表，不触碰历史维修报告表；
 * - 提供事务内的行锁读取与原子写入；权限、状态与版本条件由保存用例裁决；
 * - 步骤调序保留主键：先把既有步骤整体偏移到高位，再写回最终顺序；
 * - 删除步骤前先删除其故障面板，避免 RESTRICT 外键与孤儿数据。
 */
@Injectable()
export class RepairRequestMaintenanceService {
  constructor(
    @InjectRepository(RepairRequestEntity)
    private readonly requestRepository: Repository<RepairRequestEntity>,
    @InjectRepository(RepairRequestDiagnosticStepEntity)
    private readonly stepRepository: Repository<RepairRequestDiagnosticStepEntity>,
    @InjectRepository(RepairRequestFaultPanelEntity)
    private readonly panelRepository: Repository<RepairRequestFaultPanelEntity>,
  ) {}

  /** 事务内锁定工单维修目标（pessimistic_write），并解析可信服务公司 */
  async findTargetForUpdate(
    requestId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<RepairRequestMaintenanceTargetSnapshot | null> {
    const repository = this.getRequestRepository(transactionContext);
    const entity = await repository
      .createQueryBuilder('request')
      .setLock('pessimistic_write')
      .where('request.id = :requestId', { requestId })
      .getOne();
    if (!entity) {
      return null;
    }
    const trustedServiceOrganizationId = await this.resolveTrustedServiceOrganizationId(
      entity.intakeId,
      entity.serviceOrganizationId,
      repository,
    );
    return {
      id: entity.id,
      intakeId: entity.intakeId,
      serviceOrganizationId: trustedServiceOrganizationId,
      ownerOrganizationId: entity.ownerOrganizationId,
      isAccepted: entity.isAccepted,
      acceptedByEngineerAccountId: entity.acceptedByEngineerAccountId,
      deprecated: entity.deprecated,
      handlingStatus: entity.handlingStatus,
      closureStatus: entity.closureStatus,
      maintenanceAttachmentFileId: entity.maintenanceAttachmentFileId,
      maintenanceVersionNo: entity.maintenanceVersionNo,
    };
  }

  /** 只读维修目标（不做权限裁决，供保存前快速失败与展示判断） */
  async findTarget(requestId: number): Promise<RepairRequestMaintenanceTargetSnapshot | null> {
    const entity = await this.requestRepository.findOne({ where: { id: requestId } });
    if (!entity) {
      return null;
    }
    const trustedServiceOrganizationId = await this.resolveTrustedServiceOrganizationId(
      entity.intakeId,
      entity.serviceOrganizationId,
      this.requestRepository,
    );
    return {
      id: entity.id,
      intakeId: entity.intakeId,
      serviceOrganizationId: trustedServiceOrganizationId,
      ownerOrganizationId: entity.ownerOrganizationId,
      isAccepted: entity.isAccepted,
      acceptedByEngineerAccountId: entity.acceptedByEngineerAccountId,
      deprecated: entity.deprecated,
      handlingStatus: entity.handlingStatus,
      closureStatus: entity.closureStatus,
      maintenanceAttachmentFileId: entity.maintenanceAttachmentFileId,
      maintenanceVersionNo: entity.maintenanceVersionNo,
    };
  }

  /**
   * 原子写入结构化维修记录。
   *
   * 调用前置条件（由保存用例在同一事务内完成）：
   * - 已锁定原始件（若本次绑定新原件）；
   * - 已锁定工单并核对版本/状态/接单人；
   * - 归一后的字段与步骤/面板已通过核心策略校验。
   */
  async saveMaintenance(
    data: RepairMaintenanceSaveData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const requestRepository = this.getRequestRepository(transactionContext);
    const stepRepository = this.getStepRepository(transactionContext);
    const panelRepository = this.getPanelRepository(transactionContext);

    const existingSteps = await stepRepository.find({
      where: { requestId: data.requestId },
      order: { stepNo: 'ASC', id: 'ASC' },
    });
    const existingPanels = await panelRepository.find({
      where: { requestId: data.requestId },
      order: { id: 'ASC' },
    });

    const submittedStepIds = new Set(
      data.steps.map((step) => step.id).filter((id): id is string => id !== null),
    );
    const submittedPanelIds = new Set(
      data.panels.map((panel) => panel.id).filter((id): id is string => id !== null),
    );

    // 已有 ID 必须属于当前工单，防止跨工单改写
    for (const stepId of submittedStepIds) {
      if (!existingSteps.some((step) => String(step.id) === stepId)) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.INVALID_PARAMS,
          '排查步骤不存在或不属于当前工单',
        );
      }
    }
    for (const panelId of submittedPanelIds) {
      if (!existingPanels.some((panel) => String(panel.id) === panelId)) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.INVALID_PARAMS,
          '故障面板不存在或不属于当前工单',
        );
      }
    }

    const removedStepIds = existingSteps
      .filter((step) => !submittedStepIds.has(String(step.id)))
      .map((step) => String(step.id));

    // 1) 先删面板：被移除的面板 + 关联到被删步骤的面板（不留孤儿）
    const panelIdsToDelete = existingPanels
      .filter(
        (panel) =>
          !submittedPanelIds.has(String(panel.id)) ||
          (panel.stepId !== null && removedStepIds.includes(panel.stepId)),
      )
      .map((panel) => String(panel.id));
    if (panelIdsToDelete.length > 0) {
      await panelRepository.delete({ requestId: data.requestId, id: In(panelIdsToDelete) });
    }

    // 2) 再删步骤
    if (removedStepIds.length > 0) {
      await stepRepository.delete({ requestId: data.requestId, id: In(removedStepIds) });
    }

    // 3) 既有步骤整体偏移，腾出 1..N 的最终顺序位
    if (existingSteps.length > 0) {
      await stepRepository
        .createQueryBuilder()
        .update(RepairRequestDiagnosticStepEntity)
        .set({ stepNo: () => `step_no + ${STEP_NO_OFFSET}` })
        .where('request_id = :requestId', { requestId: data.requestId })
        .execute();
    }

    // 4) 写入/更新步骤（保留主键）
    for (const step of data.steps) {
      if (step.id === null) {
        await stepRepository.insert({
          requestId: data.requestId,
          stepNo: step.stepNo,
          errorCode: step.errorCode,
          partName: step.partName,
          actionText: step.actionText,
          resultCode: step.resultCode,
        });
      } else {
        const affected = await stepRepository.update(
          { id: step.id, requestId: data.requestId },
          {
            stepNo: step.stepNo,
            errorCode: step.errorCode,
            partName: step.partName,
            actionText: step.actionText,
            resultCode: step.resultCode,
          },
        );
        if ((affected.affected ?? 0) !== 1) {
          throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '排查步骤更新失败');
        }
      }
    }

    // 5) 按最终顺序号解析真实步骤 ID（新建步骤也能被面板引用）
    const finalSteps = await stepRepository.find({
      where: { requestId: data.requestId },
      order: { stepNo: 'ASC' },
    });
    const stepIdByNo = new Map<number, string>();
    for (const step of finalSteps) {
      stepIdByNo.set(step.stepNo, String(step.id));
    }

    // 6) 写入/更新面板（差异更新，不整表重建）
    for (const panel of data.panels) {
      const stepId = panel.stepNo === null ? null : (stepIdByNo.get(panel.stepNo) ?? null);
      if (panel.panelType === 'STEP_NEW_FAULT' && stepId === null) {
        throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '故障面板关联的排查步骤不存在');
      }
      const values = {
        panelType: panel.panelType,
        stepId,
        phaseCode: panel.phaseCode,
        mainError: panel.mainError,
        unitError: panel.unitError,
        source: panel.source,
        errorType: panel.errorType,
        gpibStatus: panel.gpibStatus,
        faultStatus: panel.faultStatus,
        description: panel.description,
        action: panel.action,
      };
      if (panel.id === null) {
        await panelRepository.insert({ requestId: data.requestId, ...values });
      } else {
        const affected = await panelRepository.update(
          { id: panel.id, requestId: data.requestId },
          values,
        );
        if ((affected.affected ?? 0) !== 1) {
          throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '故障面板更新失败');
        }
      }
    }

    // 7) 条件更新工单维修事实与版本号（expectedVersion 并发保护）
    const result = await requestRepository
      .createQueryBuilder()
      .update(RepairRequestEntity)
      .set({
        maintenanceDate: data.maintenanceDate,
        maintenanceEngineerNameSnapshot: data.engineerName,
        resetResult: data.resetResult,
        supplementaryNote: data.supplementaryNote,
        maintenanceVersionNo: () => 'maintenance_version_no + 1',
      })
      .where('id = :requestId', { requestId: data.requestId })
      .andWhere('maintenance_version_no = :expectedVersion', {
        expectedVersion: data.expectedVersion,
      })
      .execute();
    if ((result.affected ?? 0) !== 1) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.PROCESS_VERSION_CONFLICT,
        '维修记录已被其他人更新，请刷新后重试',
        { requestId: data.requestId },
      );
    }
  }

  /** 绑定维修原件到工单（仅在原件已由任务 11 绑定用例推进为 BOUND 后调用） */
  async attachMaintenanceFile(
    requestId: number,
    fileId: string,
    expectedVersion: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.getRequestRepository(transactionContext);
    const result = await repository
      .createQueryBuilder()
      .update(RepairRequestEntity)
      .set({ maintenanceAttachmentFileId: fileId })
      .where('id = :requestId', { requestId })
      .andWhere('maintenance_attachment_file_id IS NULL')
      .andWhere('maintenance_version_no = :expectedVersion', { expectedVersion })
      .execute();
    if ((result.affected ?? 0) !== 1) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.PROCESS_ORIGINAL_IMMUTABLE,
        '工单已绑定维修原件，不能替换',
        { requestId },
      );
    }
  }

  private async resolveTrustedServiceOrganizationId(
    intakeId: number | null,
    serviceOrganizationId: number | null,
    repository: Repository<RepairRequestEntity>,
  ): Promise<number | null> {
    if (intakeId === null || serviceOrganizationId === null) {
      return null;
    }
    const intake = await repository.manager.getRepository(RepairRequestIntakeEntity).findOne({
      where: { id: intakeId },
      select: { id: true, serviceOrganizationId: true },
    });
    return intake !== null && intake.serviceOrganizationId === serviceOrganizationId
      ? serviceOrganizationId
      : null;
  }

  private getRequestRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<RepairRequestEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(RepairRequestEntity) : this.requestRepository;
  }

  private getStepRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<RepairRequestDiagnosticStepEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(RepairRequestDiagnosticStepEntity) : this.stepRepository;
  }

  private getPanelRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<RepairRequestFaultPanelEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(RepairRequestFaultPanelEntity) : this.panelRepository;
  }
}
