// src/modules/lithography/repair-request-intake.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { IntakeAnalysisStatus } from '@app-types/models/repair-request.types';
import { DomainError, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';
import { isDuplicateKeyError } from '../common/utils/database-error.util';
import { RepairRequestIntakeEntity } from './entities/repair-request-intake.entity';
import {
  RepairRequestIntakeInsertData,
  RepairRequestIntakeSnapshot,
  RepairRequestReplayIntakeState,
} from './lithography.types';

/**
 * 报修原始输入写服务（任务 03「提交即出单」）。
 *
 * 职责范围：
 * - 按稳定提交标识（`record_uuid`）读取原稿事实（供同标识重放与内容核对）；
 * - 单条插入原稿，初始分析状态固定 `WAITING` + 代次 0（服务统一落库，调用方不可指定）；
 * - 回写唯一工单关联（`converted_request_id`）。
 *
 * 并发与幂等：
 * - `record_uuid` 唯一索引是「同一提交只形成一套数据」的最终保证；
 * - 插入撞唯一键映射为可区分错误码，由 usecase 在事务外重读并核对内容，
 *   不依赖应用层先查后插的竞态窗口；
 * - 插入时 `converted_request_id` 为 NULL（MySQL 唯一索引允许多个 NULL），
 *   不会与其它原稿互相占用。
 *
 * 不包含：
 * - 同标识内容/归属是否一致的判定（归 usecase）；
 * - 机型查重与登记、工单编号生成、附件绑定、首析投递（归 usecase 与各自能力）。
 */
@Injectable()
export class RepairRequestIntakeService {
  constructor(
    @InjectRepository(RepairRequestIntakeEntity)
    private readonly repository: Repository<RepairRequestIntakeEntity>,
  ) {}

  /**
   * 按提交标识读取原稿（不做归属过滤：归属核权由 usecase 完成）。
   *
   * 非事务调用使用独立连接的一致性读，能看到并发事务已提交的胜出方；
   * 这正是「事务内撞唯一键 → 事务外重放」路径所依赖的可见性。
   */
  async findByRecordUuid(
    recordUuid: string,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<RepairRequestIntakeSnapshot | null> {
    const repository = this.getRepository(transactionContext);
    const entity = await repository.findOne({ where: { recordUuid } });
    return entity ? this.toSnapshot(entity) : null;
  }

  /**
   * 插入原稿：分析意图 `WAITING` + 代次 0 在本方法内统一落库。
   *
   * 任何插入失败都不留半行：异常原样上抛由事务回滚；
   * 唯一键冲突映射 `SUBMISSION_DUPLICATE`，供 usecase 事务外重放。
   */
  async insertIntake(
    data: RepairRequestIntakeInsertData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<RepairRequestIntakeSnapshot> {
    const repository = this.getRepository(transactionContext);
    try {
      const entity = repository.create({
        recordUuid: data.recordUuid,
        customerAccountId: data.customerAccountId,
        customerOrganizationId: data.customerOrganizationId,
        serviceOrganizationId: data.serviceOrganizationId,
        equipmentModelId: data.equipmentModelId,
        errorCode: data.errorCode,
        faultDescription: data.faultDescription,
        fileId: data.fileId,
        analysisStatus: IntakeAnalysisStatus.WAITING,
        analysisGeneration: 0,
        convertedRequestId: null,
        deletedAt: null,
      });
      const saved = await repository.save(entity);
      return this.toSnapshot(saved);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.SUBMISSION_DUPLICATE,
          '同一提交标识已被占用',
          { recordUuid: data.recordUuid },
          error,
        );
      }
      // 客户端可见 details 不携带表名/SQL/约束；底层异常只作 cause 留待日志
      throw new DomainError(
        REPAIR_REQUEST_ERROR.CREATION_FAILED,
        '报修原稿保存失败，请稍后重试',
        undefined,
        error,
      );
    }
  }

  /**
   * 按工单 ID 在同一删除事务内软删原稿：客户删除报修时原稿与工单一起进入删除态。
   * 条件更新要求原稿尚未删除；迟到首析写回会因 deleted_at 非空被拒绝。
   */
  async markDeletedByRequestId(
    params: { requestId: number },
    transactionContext: PersistenceTransactionContext,
  ): Promise<number> {
    const repository = this.getRepository(transactionContext);
    const result = await repository
      .createQueryBuilder()
      .update(RepairRequestIntakeEntity)
      .set({ deletedAt: () => 'CURRENT_TIMESTAMP(3)' })
      .where('converted_request_id = :requestId', { requestId: params.requestId })
      .andWhere('deleted_at IS NULL')
      .execute();
    return result.affected ?? 0;
  }

  /**
   * 回写唯一工单关联：原稿 ↔ 工单双向关联中的「工单 → 原稿」方向由工单列表达，
   * 本方法只补「原稿 → 工单」方向。必须与工单插入同事务。
   *
   * 条件更新要求转换列仍为空，避免并发/重放把已关联的原稿改指到另一张工单。
   */
  async markConverted(
    params: { intakeId: number; requestId: number },
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.getRepository(transactionContext);
    try {
      const result = await repository
        .createQueryBuilder()
        .update(RepairRequestIntakeEntity)
        .set({ convertedRequestId: params.requestId })
        .where('id = :intakeId', { intakeId: params.intakeId })
        .andWhere('converted_request_id IS NULL')
        .execute();
      if ((result.affected ?? 0) !== 1) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.CREATION_FAILED,
          '报修与工单关联失败，请稍后重试',
          { intakeId: params.intakeId, requestId: params.requestId },
        );
      }
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      throw new DomainError(
        REPAIR_REQUEST_ERROR.CREATION_FAILED,
        '报修与工单关联失败，请稍后重试',
        { intakeId: params.intakeId, requestId: params.requestId },
        error,
      );
    }
  }

  /**
   * 同标识重放核验的原稿侧锁读（PR #27 复审）。
   *
   * 必须在 usecase 事务内调用：排他行锁与删除链路「软删原稿」的条件更新串行，
   * 保证删除与重放并发时核验结论取自单一提交点，不靠非原子一致性读得出虚假成功。
   * 锁顺序由 usecase 统一为「工单行 → 原稿行」，与删除链路的更新顺序一致，避免反向锁等待。
   * 只读最小状态列；归属/关联/删除的判定归 usecase。
   */
  async findReplayIntakeStateForUpdate(
    recordUuid: string,
    transactionContext: PersistenceTransactionContext,
  ): Promise<RepairRequestReplayIntakeState | null> {
    const repository = this.getRepository(transactionContext);
    const entity = await repository.findOne({
      where: { recordUuid },
      select: { id: true, customerAccountId: true, convertedRequestId: true, deletedAt: true },
      lock: { mode: 'pessimistic_write' },
    });
    return entity
      ? {
          id: entity.id,
          customerAccountId: entity.customerAccountId,
          convertedRequestId: entity.convertedRequestId,
          deleted: entity.deletedAt !== null,
        }
      : null;
  }

  private toSnapshot(entity: RepairRequestIntakeEntity): RepairRequestIntakeSnapshot {
    return {
      id: entity.id,
      recordUuid: entity.recordUuid,
      customerAccountId: entity.customerAccountId,
      customerOrganizationId: entity.customerOrganizationId,
      serviceOrganizationId: entity.serviceOrganizationId,
      equipmentModelId: entity.equipmentModelId,
      errorCode: entity.errorCode,
      faultDescription: entity.faultDescription,
      fileId: entity.fileId,
      analysisStatus: entity.analysisStatus,
      analysisGeneration: entity.analysisGeneration,
      convertedRequestId: entity.convertedRequestId,
      createdAt: entity.createdAt,
    };
  }

  private getRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<RepairRequestIntakeEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(RepairRequestIntakeEntity) : this.repository;
  }
}
