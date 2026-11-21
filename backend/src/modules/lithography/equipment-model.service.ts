// src/modules/lithography/equipment-model.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';
import { isDuplicateKeyError } from '../common/utils/database-error.util';
import { EquipmentModelEntity } from './entities/equipment-model.entity';
import { EquipmentModelDetailSnapshot, EquipmentModelInsertData } from './lithography.types';

/**
 * 设备型号写服务（任务 03 手填机型登记）。
 *
 * 职责范围：
 * - 事务内按机型编码查重（含停用行，编码唯一索引口径）；
 * - 事务内登记新型号（启用、排序值 0，名称与编码同源）。
 *
 * 不包含：
 * - 「选择已有机型 / 手填机型」的输入语义、启用状态裁决、登记是否需要发生（归 usecase）；
 * - 事务开启（事务由创建报修用例持有并传入上下文）；
 * - 管理员机型维护能力（本任务不新增管理入口）。
 */
@Injectable()
export class EquipmentModelService {
  constructor(
    @InjectRepository(EquipmentModelEntity)
    private readonly repository: Repository<EquipmentModelEntity>,
  ) {}

  /**
   * 事务内按编码查重（排他锁读）。
   *
   * 编码比较交给数据库唯一索引口径（`utf8mb4_0900_ai_ci`，大小写不敏感），
   * 避免应用层自己归一大小写而与唯一索引产生分叉：同一编码的并发登记
   * 在这里要么命中既有行，要么在插入时撞唯一键后由调用方重读。
   */
  async findForWriteByModelCode(params: {
    modelCode: string;
    transactionContext: PersistenceTransactionContext;
  }): Promise<EquipmentModelDetailSnapshot | null> {
    const repository = this.getRepository(params.transactionContext);
    try {
      const entity = await repository.findOne({
        where: { modelCode: params.modelCode },
        lock: { mode: 'pessimistic_write' },
      });
      return entity ? this.toSnapshot(entity) : null;
    } catch (error) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.CREATION_FAILED,
        '设备型号查询失败，请稍后重试',
        undefined,
        error,
      );
    }
  }

  /**
   * 事务内登记手填机型（启用 + 排序值 0）。
   *
   * 唯一键冲突（并发登记同一编码）映射为可区分的错误码，由 usecase 在同一事务内
   * 重读胜出方；其余落库失败按系统侧失败上报，不向客户端泄露数据库细节。
   */
  async insertModel(
    data: EquipmentModelInsertData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<EquipmentModelDetailSnapshot> {
    const repository = this.getRepository(transactionContext);
    try {
      const entity = repository.create({
        modelCode: data.modelCode,
        modelName: data.modelName,
        sortOrder: 0,
        enabled: true,
      });
      const saved = await repository.save(entity);
      return this.toSnapshot(saved);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_REGISTRATION_CONFLICT,
          '设备型号登记冲突，请稍后重试',
          undefined,
          error,
        );
      }
      throw new DomainError(
        REPAIR_REQUEST_ERROR.CREATION_FAILED,
        '设备型号登记失败，请稍后重试',
        undefined,
        error,
      );
    }
  }

  private toSnapshot(entity: EquipmentModelEntity): EquipmentModelDetailSnapshot {
    return {
      id: entity.id,
      modelCode: entity.modelCode,
      modelName: entity.modelName,
      enabled: entity.enabled,
    };
  }

  private getRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<EquipmentModelEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(EquipmentModelEntity) : this.repository;
  }
}
