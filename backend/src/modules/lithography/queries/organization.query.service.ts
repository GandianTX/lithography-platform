// src/modules/lithography/queries/organization.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
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
   * 兼容入口：全部 `ACTIVE` 组织（按名称、主键稳定排序，不分页、不区分受管资格）。
   *
   * 仅服务主线既有契约的 `registrationOrganizations { id name }`（小程序注册、
   * 拒绝后凭据重提等调用方）。Web 注册页必须改用 `searchEligibleRegistrationOptions`。
   */
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
   * 精确同名存在性（Web 注册手填公司名提示专用）。
   *
   * 资格口径与候选检索一致：`status = ACTIVE AND is_managed_company = true`。
   * 名称两侧都按「先把全部空白（含 tab / 换行）合并为单个空格，再去首尾空白，
   * 最后统一小写」归一后整体相等，参数化比较，不使用 LIKE 子串 / 前缀，
   * 也不受候选分页与首屏限制。
   *
   * 归一顺序不可交换：必须先 `REGEXP_REPLACE` 再 `TRIM`，否则首尾 tab / 换行
   * 不会被 `TRIM` 移除，随后被合并成首尾空格导致漏命中。
   * 比较两侧显式 `COLLATE utf8mb4_0900_as_cs`：重音敏感（Café ≠ Cafe）、
   * 大小写敏感（两侧均已小写，仅防止库/连接级排序规则覆盖）。
   * `normalizedName` 由用例归一化后传入，本方法不再二次改写。
   */
  async existsEligibleRegistrationOptionByName(params: {
    normalizedName: string;
  }): Promise<boolean> {
    const count = await this.repository
      .createQueryBuilder('organization')
      .select('organization.id')
      .where('organization.status = :status', { status: 'ACTIVE' })
      .andWhere('organization.is_managed_company = :isManagedCompany', {
        isManagedCompany: true,
      })
      .andWhere(
        "LOWER(TRIM(REGEXP_REPLACE(organization.name, '\\\\s+', ' '))) COLLATE utf8mb4_0900_as_cs = :normalizedName COLLATE utf8mb4_0900_as_cs",
        { normalizedName: params.normalizedName },
      )
      .getCount();
    return count > 0;
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
   * 旧 `register` 入口（`RegistrationEntryChannel.LEGACY`）、`WeappRegisterUsecase` 与
   * `ResubmitEngineerRegistrationUsecase` 使用；Web 注册入口必须改用
   * `findEligibleRegistrationOption`，不得退回本方法。
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

  /**
   * 按主键读取组织显示名称（只读，**不过滤状态**）。
   *
   * 仅用于「已经发生的业务事实」的展示：本人申请里的目标公司即使后来被停用，
   * 申请人仍应看到自己申请的是哪家公司。授权与注册资格判定不得使用本方法。
   */
  async findOrganizationNameById(params: {
    organizationId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<string | null> {
    const repository = this.getRepository(params.transactionContext);
    const row = await repository.findOne({
      where: { id: params.organizationId },
      select: { id: true, name: true },
    });
    return row ? row.name : null;
  }

  private getRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<OrganizationEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(OrganizationEntity) : this.repository;
  }
}

/** LIKE 模式转义：`\`、`%`、`_` 按普通字符匹配（MySQL 默认转义符为 `\`） */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
