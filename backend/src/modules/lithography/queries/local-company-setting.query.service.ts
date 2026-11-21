// src/modules/lithography/queries/local-company-setting.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';
import { LocalCompanySettingEntity } from '../entities/local-company-setting.entity';
import { toLocalCompanySettingSnapshot } from '../local-runtime.mapper';
import type { LocalCompanySettingSnapshot } from '../local-runtime.types';

/**
 * 同机多公司配置只读服务（任务 09 S1）。
 *
 * 只读：计划与云开关的写入（含首次初始化建计划）由 S3 的用例在事务内完成，
 * 本服务不提供任何写入方法，避免只读页面产生副作用。
 *
 * 范围口径：`organizationId === null` 表示一级管理员的全局授权范围，
 * 返回本设备全部公司配置；否则只返回该公司的单行配置。
 */
@Injectable()
export class LocalCompanySettingQueryService {
  constructor(
    @InjectRepository(LocalCompanySettingEntity)
    private readonly repository: Repository<LocalCompanySettingEntity>,
  ) {}

  /** 读取指定设备公司范围的公司配置（按公司升序，便于稳定展示） */
  async listForScope(
    installationId: string,
    organizationId: number | null,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<LocalCompanySettingSnapshot[]> {
    const where = organizationId === null ? { installationId } : { installationId, organizationId };
    const rows = await this.pickRepository(transactionContext).find({
      where,
      order: { organizationId: 'ASC' },
    });
    return rows.map(toLocalCompanySettingSnapshot);
  }

  /** 读取单行公司配置；不存在返回 null（首次初始化尚未发生时属正常状态） */
  async readOne(
    installationId: string,
    organizationId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<LocalCompanySettingSnapshot | null> {
    const entity = await this.pickRepository(transactionContext).findOne({
      where: { installationId, organizationId },
    });
    return entity ? toLocalCompanySettingSnapshot(entity) : null;
  }

  private pickRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<LocalCompanySettingEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(LocalCompanySettingEntity) : this.repository;
  }
}
