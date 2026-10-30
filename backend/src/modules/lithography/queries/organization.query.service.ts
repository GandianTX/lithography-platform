// src/modules/lithography/queries/organization.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';
import { OrganizationEntity } from '../entities/organization.entity';
import { OrganizationRegistrationOption } from '../organization.types';

/**
 * 注册组织只读查询服务。
 *
 * 只输出允许自助注册的有效组织主键与显示名称（`status = ACTIVE`），
 * 不返回组织编码、类别、成员、管理员或任何内部资料。
 * 客户端提交的 organizationId 仅是申请参数，创建事务内仍需用本服务复核有效性。
 */
@Injectable()
export class OrganizationQueryService {
  constructor(
    @InjectRepository(OrganizationEntity)
    private readonly repository: Repository<OrganizationEntity>,
  ) {}

  /** 有效组织选项列表（按名称、主键稳定排序） */
  async listActiveRegistrationOptions(
    transactionContext?: PersistenceTransactionContext,
  ): Promise<OrganizationRegistrationOption[]> {
    const repository = this.getRepository(transactionContext);
    const rows = await repository.find({
      where: { status: 'ACTIVE' },
      select: { id: true, name: true },
      order: { name: 'ASC', id: 'ASC' },
    });
    return rows.map((row) => ({ id: row.id, name: row.name }));
  }

  /** 按主键复核组织仍为 ACTIVE；不存在或已停用返回 null */
  async findActiveRegistrationOption(params: {
    organizationId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<OrganizationRegistrationOption | null> {
    const repository = this.getRepository(params.transactionContext);
    const row = await repository.findOne({
      where: { id: params.organizationId, status: 'ACTIVE' },
      select: { id: true, name: true },
    });
    return row ? { id: row.id, name: row.name } : null;
  }

  private getRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<OrganizationEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(OrganizationEntity) : this.repository;
  }
}
