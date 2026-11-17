// src/modules/lithography/repair-request-revision.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type {
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import { DomainError, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';
import { EngineerResponseEntity } from './entities/engineer-response.entity';
import { RepairProcessEntryEntity } from './entities/repair-process-entry.entity';
import { RepairRequestEntity } from './entities/repair-request.entity';
import { RepairRequestIntakeEntity } from './entities/repair-request-intake.entity';
import { RepairRequestRevisionEntity } from './entities/repair-request-revision.entity';

export type RepairRequestRevisionTargetSnapshot = {
  id: number;
  requestNo: string;
  customerAccountId: number;
  equipmentModelId: number;
  errorCode: string;
  faultDescription: string;
  contentMd: string;
  intakeId: number | null;
  /** 按 intakeId 读取到的 intake 服务公司；intake 缺失/不可用时为 null */
  intakeServiceOrganizationId: number | null;
  serviceOrganizationId: number | null;
  ownerOrganizationId: number | null;
  createdAt: Date;
  deprecated: boolean;
  isAccepted: boolean;
  acceptedByEngineerAccountId: number | null;
  acceptedAt: Date | null;
  handlingResult: string | null;
  handlingStatus: string | null;
  handlingRecordedAt: Date | null;
  handlingRecordedByAccountId: number | null;
  closureStatus: string | null;
  closedAt: Date | null;
  closureReason: string | null;
  handlingEndedAt: Date | null;
  currentRevisionNo: number;
};

export type RepairRequestProcessRevisionTarget = {
  id: string;
  entryUuid: string;
  requestId: number;
  operationText: string;
  testResult: string | null;
  occurredAt: Date | null;
  timeSource: string;
  fileId: string | null;
  versionNo: number;
  createdAt: Date;
};

/** 修订快照用的客户回复安全投影（不向 modules 外暴露 ORM 实体） */
export type RepairRequestResponseRevisionTarget = {
  id: number;
  responseText: string;
  resolutionStatus: string;
  createdAt: Date;
};

export type RepairRequestRevisionInsertData = {
  requestId: number;
  revisionNo: number;
  previousVersion: number;
  beforeSnapshot: string;
  afterSnapshot: string;
  schemaVersion: number;
  actorAccountId: number;
  reason: string;
};

export type RepairRequestRevisionRecord = {
  revisionNo: number;
  previousVersion: number;
  reason: string;
  actorAccountId: number;
  createdAt: Date;
};

export type RepairRequestRevisionUpdateData = {
  requestId: number;
  expectedVersion: number;
  nextVersion: number;
  contentMd?: string;
  handlingResult?: RepairRequestHandlingResult;
  handlingStatus?: RepairRequestHandlingStatus;
  handlingRecordedAt?: Date;
  handlingRecordedByAccountId?: number;
  handlingEndedAt?: Date | null;
  closureReason?: string | null;
};

export type RepairRequestProcessRevisionUpdateData = {
  requestId: number;
  entryId: string;
  expectedVersion: number;
  operationText: string;
  testResult: string | null;
};

/**
 * 工单管理修订写服务（任务 04 管理员切片）。
 *
 * 职责：工单行锁读、过程行锁读、修订行插入、条件更新与快照读取原料。
 * 不包含：管理员层级/组织范围裁决、字段白名单、原因必填、版本一致性等业务决策
 * （全部归 `AppendRepairRequestRevisionUsecase`）；事务由 usecase 持有。
 */
@Injectable()
export class RepairRequestRevisionService {
  constructor(
    @InjectRepository(RepairRequestEntity)
    private readonly requestRepository: Repository<RepairRequestEntity>,
    @InjectRepository(RepairRequestRevisionEntity)
    private readonly revisionRepository: Repository<RepairRequestRevisionEntity>,
    @InjectRepository(RepairProcessEntryEntity)
    private readonly processEntryRepository: Repository<RepairProcessEntryEntity>,
    @InjectRepository(EngineerResponseEntity)
    private readonly responseRepository: Repository<EngineerResponseEntity>,
  ) {}

  /**
   * 工单行锁读（pessimistic_write），并在同一事务内核对 intake 归属事实。
   *
   * 锁顺序固定为「工单 → intake（共享锁）→ 过程」：
   * - 工单行先以排他锁固定组织归属与版本；
   * - 有 intake 时以共享锁读取 intake 服务公司，防止读取后被并发改写；
   * - 过程行随后排他锁定。
   *
   * 现有写路径（结单/过程写入）为「原件 → 工单 → 过程」，不持有 intake 锁；
   * 本路径在工单之后才取 intake 共享锁，不构成反向锁序。intake 记录缺失或
   * 读取失败时返回 null，由用例按失败关闭拒绝，不回退 owner。
   */
  async lockRequestForRevision(
    requestId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<RepairRequestRevisionTargetSnapshot | null> {
    const repository = this.getRequestRepository(transactionContext);
    try {
      const entity = await repository.findOne({
        where: { id: requestId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entity) {
        return null;
      }
      const snapshot = this.toTargetSnapshot(entity);
      const intakeId = entity.intakeId ?? null;
      if (intakeId === null) {
        return { ...snapshot, intakeServiceOrganizationId: null };
      }
      const intake = await repository.manager.getRepository(RepairRequestIntakeEntity).findOne({
        where: { id: intakeId },
        select: { id: true, serviceOrganizationId: true },
        lock: { mode: 'pessimistic_read' },
      });
      return {
        ...snapshot,
        intakeServiceOrganizationId: intake?.serviceOrganizationId ?? null,
      };
    } catch (error) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.PROCESS_WRITE_FAILED,
        '工单修订失败，请稍后重试',
        { requestId },
        error,
      );
    }
  }

  /** 锁定工单全部过程行（pessimistic_write），修订快照与版本核对共用 */
  async lockProcessEntriesForRevision(
    requestId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<RepairRequestProcessRevisionTarget[]> {
    const repository = this.getProcessEntryRepository(transactionContext);
    try {
      const rows = await repository.find({
        where: { requestId },
        order: { createdAt: 'ASC', id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      return rows.map((row) => this.toProcessTarget(row));
    } catch (error) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.PROCESS_WRITE_FAILED,
        '工单修订失败，请稍后重试',
        { requestId },
        error,
      );
    }
  }

  /** 读取工单全部客户回复（快照用，稳定顺序） */
  async listResponsesForSnapshot(
    requestId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<RepairRequestResponseRevisionTarget[]> {
    const repository = this.getResponseRepository(transactionContext);
    const rows = await repository.find({
      where: { requestId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    return rows.map((row) => ({
      id: row.id,
      responseText: row.responseText,
      resolutionStatus: row.resolutionStatus,
      createdAt: row.createdAt,
    }));
  }

  /**
   * 条件更新工单可修订字段与当前版本号。
   * 命中 0 行表示版本已变化或工单已删除，由 usecase 裁决为版本冲突。
   */
  async updateRequestRevisionFields(
    data: RepairRequestRevisionUpdateData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<number> {
    const repository = this.getRequestRepository(transactionContext);
    const set: Record<string, unknown> = { currentRevisionNo: data.nextVersion };
    if (data.contentMd !== undefined) {
      set.contentMd = data.contentMd;
    }
    if (data.handlingResult !== undefined) {
      set.handlingResult = data.handlingResult;
      set.handlingStatus = data.handlingStatus;
      set.handlingRecordedAt = data.handlingRecordedAt;
      set.handlingRecordedByAccountId = data.handlingRecordedByAccountId;
      set.handlingEndedAt = data.handlingEndedAt;
    }
    if (data.closureReason !== undefined) {
      set.closureReason = data.closureReason;
    }

    try {
      const result = await repository
        .createQueryBuilder()
        .update(RepairRequestEntity)
        .set(set)
        .where('id = :requestId', { requestId: data.requestId })
        .andWhere('deprecated = :deprecated', { deprecated: false })
        .andWhere('current_revision_no = :expectedVersion', {
          expectedVersion: data.expectedVersion,
        })
        .execute();
      return result.affected ?? 0;
    } catch (error) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.PROCESS_WRITE_FAILED,
        '工单修订失败，请稍后重试',
        { requestId: data.requestId },
        error,
      );
    }
  }

  /** 条件更新过程文本并递增版本号；命中 0 行表示过程版本冲突 */
  async updateProcessEntryRevision(
    data: RepairRequestProcessRevisionUpdateData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<number> {
    const repository = this.getProcessEntryRepository(transactionContext);
    try {
      const result = await repository
        .createQueryBuilder()
        .update(RepairProcessEntryEntity)
        .set({
          operationText: data.operationText,
          testResult: data.testResult,
          versionNo: () => 'version_no + 1',
        })
        .where('id = :entryId', { entryId: data.entryId })
        .andWhere('request_id = :requestId', { requestId: data.requestId })
        .andWhere('version_no = :expectedVersion', { expectedVersion: data.expectedVersion })
        .execute();
      return result.affected ?? 0;
    } catch (error) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.PROCESS_WRITE_FAILED,
        '工单修订失败，请稍后重试',
        { requestId: data.requestId, entryId: data.entryId },
        error,
      );
    }
  }

  /** 插入修订历史行（保存修改人、原因、前后快照与版本号） */
  async insertRevision(
    data: RepairRequestRevisionInsertData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<RepairRequestRevisionRecord> {
    const repository = this.getRevisionRepository(transactionContext);
    try {
      const saved = await repository.save(
        repository.create({
          requestId: data.requestId,
          revisionNo: data.revisionNo,
          previousVersion: data.previousVersion,
          beforeSnapshot: data.beforeSnapshot,
          afterSnapshot: data.afterSnapshot,
          schemaVersion: data.schemaVersion,
          actorAccountId: data.actorAccountId,
          reason: data.reason,
        }),
      );
      return {
        revisionNo: saved.revisionNo,
        previousVersion: saved.previousVersion,
        reason: saved.reason,
        actorAccountId: saved.actorAccountId,
        createdAt: saved.createdAt,
      };
    } catch (error) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.PROCESS_WRITE_FAILED,
        '工单修订失败，请稍后重试',
        { requestId: data.requestId, revisionNo: data.revisionNo },
        error,
      );
    }
  }

  private toTargetSnapshot(entity: RepairRequestEntity): RepairRequestRevisionTargetSnapshot {
    return {
      id: entity.id,
      requestNo: entity.requestNo,
      customerAccountId: entity.customerAccountId,
      equipmentModelId: entity.equipmentModelId,
      errorCode: entity.errorCode,
      faultDescription: entity.faultDescription,
      contentMd: entity.contentMd,
      intakeId: entity.intakeId,
      intakeServiceOrganizationId: null,
      serviceOrganizationId: entity.serviceOrganizationId,
      ownerOrganizationId: entity.ownerOrganizationId,
      createdAt: entity.createdAt,
      deprecated: entity.deprecated,
      isAccepted: entity.isAccepted,
      acceptedByEngineerAccountId: entity.acceptedByEngineerAccountId,
      acceptedAt: entity.acceptedAt,
      handlingResult: entity.handlingResult,
      handlingStatus: entity.handlingStatus,
      handlingRecordedAt: entity.handlingRecordedAt,
      handlingRecordedByAccountId: entity.handlingRecordedByAccountId,
      closureStatus: entity.closureStatus,
      closedAt: entity.closedAt,
      closureReason: entity.closureReason,
      handlingEndedAt: entity.handlingEndedAt,
      currentRevisionNo: entity.currentRevisionNo,
    };
  }

  private toProcessTarget(entity: RepairProcessEntryEntity): RepairRequestProcessRevisionTarget {
    return {
      id: String(entity.id),
      entryUuid: entity.entryUuid,
      requestId: entity.requestId,
      operationText: entity.operationText,
      testResult: entity.testResult,
      occurredAt: entity.occurredAt,
      timeSource: entity.timeSource,
      fileId: entity.fileId,
      versionNo: entity.versionNo,
      createdAt: entity.createdAt,
    };
  }

  private getRequestRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<RepairRequestEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(RepairRequestEntity) : this.requestRepository;
  }

  private getRevisionRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<RepairRequestRevisionEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(RepairRequestRevisionEntity) : this.revisionRepository;
  }

  private getProcessEntryRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<RepairProcessEntryEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(RepairProcessEntryEntity) : this.processEntryRepository;
  }

  private getResponseRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<EngineerResponseEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(EngineerResponseEntity) : this.responseRepository;
  }
}
