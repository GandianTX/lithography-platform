// src/modules/lithography/queries/organization-membership.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { In, Repository } from 'typeorm';
import { OrganizationEntity } from '../entities/organization.entity';
import { OrganizationMembershipEntity } from '../entities/organization-membership.entity';
import { OrganizationMembershipFact } from '../organization.types';

/**
 * 组织成员事实查询服务（A-PR0 计划 §2.1）
 *
 * 职责范围：
 * - 单一账号的有效成员关系事实（含组织编码/名称/类别与成员角色）
 * - 「有效」口径统一：成员关系 ACTIVE 且所属组织 ACTIVE；
 *   被停用组织的成员事实不参与任何权限解析（组织停用即刻失效，无需逐个退役成员）
 *
 * 不包含：
 * - 组织上下文决议（0/1/N 的拒绝口径由 core policy + usecase 决策）
 * - 任何写入（S2c 的成员绑定由 usecase 在事务内编排）
 */
@Injectable()
export class OrganizationMembershipQueryService {
  constructor(
    @InjectRepository(OrganizationMembershipEntity)
    private readonly membershipRepository: Repository<OrganizationMembershipEntity>,
    @InjectRepository(OrganizationEntity)
    private readonly organizationRepository: Repository<OrganizationEntity>,
  ) {}

  /**
   * 账号的全部有效成员关系事实（按成员关系主键升序，稳定顺序便于歧义判定与测试）。
   *
   * @param params.accountId 账号 ID（必须来自可信 Session）
   * @param params.transactionContext 可选事务上下文（写用例在同一事务连接上读最新事实）
   */
  async listActiveMembershipsByAccount(params: {
    accountId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<OrganizationMembershipFact[]> {
    const membershipRepository = this.getMembershipRepository(params.transactionContext);
    const memberships = await membershipRepository.find({
      where: { accountId: params.accountId, status: 'ACTIVE' },
      order: { id: 'ASC' },
    });
    return this.attachActiveOrganizations(memberships, params.transactionContext);
  }

  /**
   * 账号在指定组织内的有效成员关系事实；不存在或组织已停用时返回 null。
   * 供用例核验「操作者属于目标组织」的成员资格（不信任客户端自报组织）。
   */
  async findActiveMembership(params: {
    accountId: number;
    organizationId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<OrganizationMembershipFact | null> {
    const membershipRepository = this.getMembershipRepository(params.transactionContext);
    const membership = await membershipRepository.findOne({
      where: {
        accountId: params.accountId,
        organizationId: params.organizationId,
        status: 'ACTIVE',
      },
    });
    if (!membership) {
      return null;
    }
    const facts = await this.attachActiveOrganizations([membership], params.transactionContext);
    return facts[0] ?? null;
  }

  /**
   * 指定组织内的有效成员账号 ID 列表（成员 ACTIVE 且组织 ACTIVE）。
   *
   * 供管理员用户管理按「管理员可信组织」收窄可见/可写范围：组织不存在或已停用时返回空
   * 列表（调用方据此得到空页，而不是退化为全库账号）。账号 ID 清单由 usecase 下推给
   * account 域 QueryService，避免 account 侧跨域导入组织 Entity。
   *
   * @param params.organizationId 可信解析得到的组织主键（不得取自客户端自报）
   * @param params.transactionContext 可选事务上下文（写用例在同一事务连接上读最新事实）
   */
  async listActiveAccountIdsByOrganization(params: {
    organizationId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<number[]> {
    const organizationRepository = this.getOrganizationRepository(params.transactionContext);
    const organization = await organizationRepository.findOne({
      where: { id: params.organizationId, status: 'ACTIVE' },
    });
    if (!organization) {
      return [];
    }
    const membershipRepository = this.getMembershipRepository(params.transactionContext);
    const memberships = await membershipRepository.find({
      where: { organizationId: params.organizationId, status: 'ACTIVE' },
      order: { id: 'ASC' },
    });
    return memberships.map((item) => item.accountId);
  }

  /**
   * 批量装配组织事实，仅保留组织仍为 ACTIVE 的成员关系（单次 IN 查询，避免逐行读取）。
   */
  private async attachActiveOrganizations(
    memberships: readonly OrganizationMembershipEntity[],
    transactionContext?: PersistenceTransactionContext,
  ): Promise<OrganizationMembershipFact[]> {
    if (memberships.length === 0) {
      return [];
    }
    const organizationIds = Array.from(new Set(memberships.map((item) => item.organizationId)));
    const organizationRepository = this.getOrganizationRepository(transactionContext);
    const organizations = await organizationRepository.find({
      where: { id: In(organizationIds), status: 'ACTIVE' },
    });
    const organizationById = new Map(organizations.map((item) => [item.id, item] as const));

    const facts: OrganizationMembershipFact[] = [];
    for (const membership of memberships) {
      const organization = organizationById.get(membership.organizationId);
      if (!organization) {
        continue;
      }
      facts.push({
        membershipId: membership.id,
        organizationId: organization.id,
        organizationCode: organization.organizationCode,
        organizationName: organization.name,
        organizationKind: organization.kind,
        memberRole: membership.memberRole,
      });
    }
    return facts;
  }

  private getMembershipRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<OrganizationMembershipEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager
      ? manager.getRepository(OrganizationMembershipEntity)
      : this.membershipRepository;
  }

  private getOrganizationRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<OrganizationEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(OrganizationEntity) : this.organizationRepository;
  }
}
