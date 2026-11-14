// src/modules/lithography/queries/organization.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { escapeLikePattern } from '@modules/common/utils/sql-like-pattern.util';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';
import { OrganizationEntity } from '../entities/organization.entity';
import {
  OrganizationRegistrationOption,
  OrganizationRegistrationOptionPage,
  OrganizationRegistrationOptionQuery,
} from '../organization.types';

/** Web 注册候选单页上限：公开查询只服务选择器，超过上限按上限截断 */
const REGISTRATION_OPTION_PAGE_SIZE_MAX = 50;

/**
 * 注册组织只读查询服务。
 *
 * 只输出允许自助注册的有效组织主键与显示名称，不返回组织编码、类别、成员、
 * 管理员或任何内部资料。两种资格口径：
 * - Web 注册（当前自助注册页）：`status = ACTIVE AND is_managed_company = true`；
 * - 旧入口（小程序注册、拒绝后凭据重提）：仅 `status = ACTIVE`，保持既有行为不变。
 *
 * 客户端提交的 organizationId 仅是申请参数，创建事务内仍需用本服务复核有效性。
 */
@Injectable()
export class OrganizationQueryService {
  constructor(
    @InjectRepository(OrganizationEntity)
    private readonly repository: Repository<OrganizationEntity>,
  ) {}

  /**
   * Web 注册候选检索：启用且属于一级维护名单，支持名称关键字与 OFFSET 分页。
   * 名称匹配走参数化 LIKE，通配符转义后只作普通字符；排序固定为名称、主键升序。
   */
  async searchEligibleRegistrationOptions(
    query: OrganizationRegistrationOptionQuery,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<OrganizationRegistrationOptionPage> {
    const page = Math.max(query.pagination.page, 1);
    const pageSize = Math.min(
      Math.max(query.pagination.pageSize, 1),
      REGISTRATION_OPTION_PAGE_SIZE_MAX,
    );
    const keyword = query.keyword?.trim();

    const qb = this.getRepository(transactionContext)
      .createQueryBuilder('organization')
      .select(['organization.id', 'organization.name'])
      .where('organization.status = :status', { status: 'ACTIVE' })
      .andWhere('organization.is_managed_company = :isManagedCompany', {
        isManagedCompany: true,
      })
      .orderBy('organization.name', 'ASC')
      .addOrderBy('organization.id', 'ASC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (keyword) {
      qb.andWhere('organization.name LIKE :keyword', {
        keyword: `%${escapeLikePattern(keyword)}%`,
      });
    }

    const [rows, total] = await qb.getManyAndCount();
    return {
      items: rows.map((row) => ({ id: row.id, name: row.name })),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 按主键复核组织具备 Web 注册资格（`ACTIVE` 且属于一级维护名单）。
   * 不存在、已停用或已撤销受管资格统一返回 null。
   *
   * 传入事务上下文时按当前读加共享行锁（`pessimistic_read`）：复核与后续关联
   * 写入之间，并发「停用组织 / 撤销受管资格」必须等本事务结束，避免复核通过后
   * 用已失效的组织完成注册。仓库内写前复核统一采用该加锁口径。
   */
  async findEligibleRegistrationOption(params: {
    organizationId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<OrganizationRegistrationOption | null> {
    const repository = this.getRepository(params.transactionContext);
    const row = await repository.findOne({
      where: {
        id: params.organizationId,
        status: 'ACTIVE',
        isManagedCompany: true,
      },
      select: { id: true, name: true },
      ...(params.transactionContext ? { lock: { mode: 'pessimistic_read' as const } } : {}),
    });
    return row ? { id: row.id, name: row.name } : null;
  }

  /**
   * 按主键复核组织仍为 ACTIVE（旧入口口径）。
   *
   * 仅 `WeappRegisterUsecase` 与 `ResubmitEngineerRegistrationUsecase` 使用；
   * Web 注册必须改用 `findEligibleRegistrationOption`，不得退回本方法。
   */
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
