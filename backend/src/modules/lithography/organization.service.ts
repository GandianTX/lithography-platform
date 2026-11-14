// src/modules/lithography/organization.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';
import { OrganizationEntity } from './entities/organization.entity';

/**
 * 组织写服务。
 *
 * 本期唯一写路径：客户自助注册时手填自家公司名称，在注册事务内新建一条
 * 「启用、未受管、无维修服务资格」的公司档。
 *
 * 约束：
 * - 公司名称不唯一，同名不合并（保留同名原档，各自独立）；
 * - `organization_code` 有唯一索引，使用与名称无关的稳定独立标识，避免同名冲突；
 * - 不授予维修服务资格，也不进入一级维护名单，须由后续名单维护流程单独处理。
 */
@Injectable()
export class OrganizationService {
  constructor(
    @InjectRepository(OrganizationEntity)
    private readonly repository: Repository<OrganizationEntity>,
  ) {}

  /**
   * 新建客户手填公司。
   *
   * @param params.name 已归一化的公司名称
   * @param params.transactionContext 注册事务上下文（与账号写入同一事务）
   * @returns 新公司主键
   */
  async createSelfRegisteredCompany(params: {
    name: string;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<{ id: number }> {
    const repository = this.getRepository(params.transactionContext);
    const entity = repository.create({
      organizationCode: `SELF_REG_${randomUUID()}`,
      name: params.name,
      kind: 'CLIENT',
      status: 'ACTIVE',
      isManagedCompany: false,
      isServiceProvider: false,
    });
    const saved = await repository.save(entity);
    return { id: saved.id };
  }

  private getRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<OrganizationEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(OrganizationEntity) : this.repository;
  }
}
