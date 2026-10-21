// src/modules/lithography/organization-membership.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';
import { OrganizationMembershipEntity } from './entities/organization-membership.entity';
import { OrganizationMembershipInsertData } from './organization.types';

/**
 * 组织成员关系写服务（A-PR0 计划 §4.3）
 *
 * 职责范围：
 * - 成员关系插入（管理员创建账号时同事务绑定其当前有效组织的唯一写路径）
 *
 * 不包含：
 * - 组织上下文解析与绑定裁决（归 usecase：只绑定可信解析结果，绝不取客户端自报）
 * - 事务开启（事务边界由 usecase 通过 TransactionRunner 持有）
 * - 异常到业务错误码的收敛（由调用方按所在阶段统一裁决，本层不臆测错误语义）
 */
@Injectable()
export class OrganizationMembershipService {
  constructor(
    @InjectRepository(OrganizationMembershipEntity)
    private readonly repository: Repository<OrganizationMembershipEntity>,
  ) {}

  /**
   * 插入成员关系记录
   *
   * 初始状态由本方法统一保证：`status = 'ACTIVE'` 且 `left_at = NULL`
   * （实体 `chk_organization_membership_period` 兜底）；`joined_at` 由数据库默认值填充。
   *
   * @param data 已完成业务判定的写入数据
   * @param transactionContext 可选的事务上下文
   * @returns 写入完成后的成员关系主键
   */
  async insertMembership(
    data: OrganizationMembershipInsertData,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<{ membershipId: number }> {
    const repository = this.getRepository(transactionContext);
    const entity = repository.create({
      organizationId: data.organizationId,
      accountId: data.accountId,
      memberRole: data.memberRole,
      status: 'ACTIVE',
      leftAt: null,
    });
    const saved = await repository.save(entity);
    return { membershipId: saved.id };
  }

  private getRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<OrganizationMembershipEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(OrganizationMembershipEntity) : this.repository;
  }
}
