// src/modules/lithography/queries/equipment-model.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';
import { EquipmentModelEntity } from '../entities/equipment-model.entity';
import { EquipmentModelDetailSnapshot, EquipmentModelView } from '../lithography.types';

/**
 * 设备型号读侧查询服务
 *
 * 职责范围：
 * - 读取启用状态的设备型号列表（客户创建维修申请下拉框数据源）
 * - 按 ID 读取单个设备型号详情（含启用状态，供写流程做事务内校验）
 * - 按机型编码只读比对（任务 03 同标识重放的机型一致性核对）
 *
 * 不包含：
 * - 写入与事务编排（手填机型登记在 `EquipmentModelService`，查重带锁读也在写服务）
 * - 设备型号的新增/停用等管理能力
 */
@Injectable()
export class EquipmentModelQueryService {
  constructor(
    @InjectRepository(EquipmentModelEntity)
    private readonly repository: Repository<EquipmentModelEntity>,
  ) {}

  /**
   * 读取全部启用设备型号，按显示排序值升序
   *
   * @param transactionContext 可选的事务上下文
   * @returns 启用设备型号视图列表
   */
  async listEnabledModels(
    transactionContext?: PersistenceTransactionContext,
  ): Promise<EquipmentModelView[]> {
    const repository = this.getRepository(transactionContext);
    const entities = await repository.find({
      where: { enabled: true },
      order: { sortOrder: 'ASC', id: 'ASC' },
    });
    return entities.map((entity) => this.toView(entity));
  }

  /**
   * 按 ID 读取设备型号详情（含停用型号）
   *
   * 携带事务上下文时加排他锁（SELECT ... FOR UPDATE），防止并发停用：
   * 停用事务必须先等本事务提交，保证“校验启用 → 插入”窗口内型号状态稳定。
   * 非事务调用（无锁需求）保持普通快照读。
   *
   * @param params 查询参数
   * @returns 设备型号详情快照；不存在时返回 null
   */
  async findModelById(params: {
    id: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<EquipmentModelDetailSnapshot | null> {
    const repository = this.getRepository(params.transactionContext);
    const entity = await repository.findOne({
      where: { id: params.id },
      ...(params.transactionContext ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!entity) {
      return null;
    }
    return {
      ...this.toView(entity),
      enabled: entity.enabled,
    };
  }

  /**
   * 按机型编码读取详情（只读、无锁，含停用型号）。
   *
   * 仅用于「已在库事实」的比对（任务 03 同标识重放核对手填机型是否仍指向同一行），
   * 不做查重登记，也不改变机型启用状态。
   */
  async findModelByCode(params: {
    modelCode: string;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<EquipmentModelDetailSnapshot | null> {
    const repository = this.getRepository(params.transactionContext);
    const entity = await repository.findOne({ where: { modelCode: params.modelCode } });
    if (!entity) {
      return null;
    }
    return {
      ...this.toView(entity),
      enabled: entity.enabled,
    };
  }

  private toView(entity: EquipmentModelEntity): EquipmentModelView {
    return {
      id: entity.id,
      modelCode: entity.modelCode,
      modelName: entity.modelName,
    };
  }

  private getRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<EquipmentModelEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(EquipmentModelEntity) : this.repository;
  }
}
