// src/modules/lithography/queries/organization-membership.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { In, Repository } from 'typeorm';
import { OrganizationEntity } from '../entities/organization.entity';
import { OrganizationMembershipEntity } from '../entities/organization-membership.entity';
import {
  OrganizationMembershipFact,
  OrganizationMembershipBindingFact,
} from '../organization.types';

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
   * 写入前核对用的成员关系全集（**不按有效口径过滤**）。
   *
   * 与 `listActiveMembershipsByAccount` 刻意分开：客户补录等写入场景必须同时看到
   * 「停用组织上的 ACTIVE 成员关系」与「`LEFT` 历史成员关系」，因为它们分别占用
   * `uk_organization_membership_active_account` 与
   * `uk_organization_membership_org_account` 两个唯一键。返回事实含成员状态与组织状态，
   * 由调用方在写 FK / 成员之前裁决并失败关闭。
   *
   * 组织行缺失时（外键 RESTRICT 下不应发生）跳过该行，避免给出不可判定的成员事实。
   *
   * @param params.accountId 账号 ID（必须来自可信 Session）
   * @param params.transactionContext 可选事务上下文（写用例在同一事务连接上读最新事实）
   */
  async listMembershipsForBinding(params: {
    accountId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<OrganizationMembershipBindingFact[]> {
    const membershipRepository = this.getMembershipRepository(params.transactionContext);
    const memberships = await membershipRepository.find({
      where: { accountId: params.accountId },
      order: { id: 'ASC' },
    });
    if (memberships.length === 0) {
      return [];
    }
    const organizationIds = Array.from(new Set(memberships.map((item) => item.organizationId)));
    const organizationRepository = this.getOrganizationRepository(params.transactionContext);
    const organizations = await organizationRepository.find({
      where: { id: In(organizationIds) },
    });
    const organizationById = new Map(organizations.map((item) => [item.id, item] as const));

    const facts: OrganizationMembershipBindingFact[] = [];
    for (const membership of memberships) {
      const organization = organizationById.get(membership.organizationId);
      if (!organization) {
        continue;
      }
      facts.push({
        membershipId: membership.id,
        organizationId: membership.organizationId,
        memberRole: membership.memberRole,
        membershipStatus: membership.status,
        organizationStatus: organization.status,
      });
    }
    return facts;
  }

  /**
   * 指定组织内的有效**工程师**成员账号 ID 列表（成员 ACTIVE 且组织 ACTIVE）。
   *
   * 供二级管理员用户管理按真实角色收窄工程师范围（V5.5 R012-01）：客户归属以资料列
   * `customer_organization_id` 为准，不能复用本清单；因此这里显式只取 `ENGINEER`
   * 成员关系，避免把客户或组织管理员成员混进工程师范围。
   *
   * 组织不存在或已停用时返回空列表；调用方仍需保留客户条件，不能据此判定范围为空。
   */
  async listActiveEngineerAccountIdsByOrganization(params: {
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
      where: {
        organizationId: params.organizationId,
        status: 'ACTIVE',
        memberRole: 'ENGINEER',
      },
      order: { id: 'ASC' },
    });
    return memberships.map((item) => item.accountId);
  }

  /**
   * 指定组织的全部成员关系（不按状态过滤，由调用方判定成员是否有效）。
   *
   * 供绑定判定与凭据写入口使用：`memberRole` / 成员状态都是判定输入，因此不能在
   * 查询层提前丢弃；按成员关系主键升序稳定输出。`forUpdate=true` 时取
   * `pessimistic_write`（写用例在持有公司行锁后调用，锁序 organization → account →
   * membership）。
   */
  async listMembershipsByOrganization(params: {
    organizationId: number;
    transactionContext?: PersistenceTransactionContext;
    forUpdate?: boolean;
  }): Promise<
    Array<{ membershipId: number; accountId: number; memberRole: string; status: string }>
  > {
    const membershipRepository = this.getMembershipRepository(params.transactionContext);
    const memberships = await membershipRepository.find({
      where: { organizationId: params.organizationId },
      order: { id: 'ASC' },
      ...(params.forUpdate === true ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    return memberships.map((item) => ({
      membershipId: item.id,
      accountId: item.accountId,
      memberRole: item.memberRole,
      status: item.status,
    }));
  }

  /**
   * 批量读取多个组织的 ACTIVE 成员关系（一次 `IN` 查询，按成员关系主键升序）。
   *
   * 供「已绑定二级管理员」列表在不做 N+1 的前提下装配绑定判定输入；只返回
   * 判定所需的账号、成员角色与成员状态，不返回组织联系方式或账号资料。
   * 不按组织状态过滤：是否受管、是否停用由调用方按公司事实裁决。
   */
  async listActiveMembershipsByOrganizationIds(params: {
    organizationIds: ReadonlyArray<number>;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<Map<number, Array<{ accountId: number; memberRole: string; status: string }>>> {
    const organizationIds = [
      ...new Set(params.organizationIds.filter((id) => Number.isInteger(id) && id > 0)),
    ];
    if (organizationIds.length === 0) {
      return new Map();
    }
    const membershipRepository = this.getMembershipRepository(params.transactionContext);
    const memberships = await membershipRepository.find({
      where: { organizationId: In(organizationIds), status: 'ACTIVE' },
      order: { id: 'ASC' },
    });
    const grouped = new Map<
      number,
      Array<{ accountId: number; memberRole: string; status: string }>
    >();
    for (const item of memberships) {
      const list = grouped.get(item.organizationId) ?? [];
      list.push({ accountId: item.accountId, memberRole: item.memberRole, status: item.status });
      grouped.set(item.organizationId, list);
    }
    return grouped;
  }

  /**
   * 指定组织内全部有效成员关系的账号 ID 列表（成员 ACTIVE，去重，按成员关系主键升序）。
   *
   * 刻意**不**按组织状态过滤：调用方已在事务内持有公司行锁并刚刚变更其状态，
   * 停用后组织行即为非 ACTIVE，若在此过滤会漏掉需要撤销会话的成员。快照撤销以
   * 「变更前仍处于 ACTIVE 的成员关系」为准，组织状态由调用方裁决。
   *
   * 是否只撤销管理类成员由调用方用账号侧事实（`admin_level`）再筛，本服务不跨域
   * 读取账号表。
   */
  async listActiveMembershipAccountIdsByOrganization(params: {
    organizationId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<number[]> {
    const membershipRepository = this.getMembershipRepository(params.transactionContext);
    const memberships = await membershipRepository.find({
      where: { organizationId: params.organizationId, status: 'ACTIVE' },
      order: { id: 'ASC' },
    });
    return Array.from(new Set(memberships.map((item) => item.accountId)));
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
