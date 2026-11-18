// src/modules/lithography/queries/organization.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { In, Repository } from 'typeorm';
import { OrganizationEntity } from '../entities/organization.entity';
import {
  AdminOrganizationListQuery,
  AdminOrganizationPage,
  AdminOrganizationView,
  OrganizationNameOptionPage,
  OrganizationNameOptionQuery,
  OrganizationRegistrationOption,
  OrganizationRegistrationOptionPage,
  OrganizationRegistrationOptionQuery,
  OrganizationServiceProviderOptionPage,
  OrganizationServiceProviderOptionQuery,
} from '../organization.types';

/** Web 注册候选单页上限：公开查询只服务选择器，超过上限按上限截断 */
const REGISTRATION_OPTION_PAGE_SIZE_MAX = 50;

/** 报修服务候选与管理端名称名单单页上限：同样只服务选择器 */
const SELECTOR_OPTION_PAGE_SIZE_MAX = 50;

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
   * 报修服务候选检索：启用且具备维修服务资格，支持名称关键字与 OFFSET 分页。
   *
   * 与注册候选刻意分离：维修资格 `is_service_provider` 不参与注册判断，受管归类
   * `is_managed_company` 也不参与维修判断。只返回选择所需的 `id` / `name` / `shortName`。
   * 调用方（任务 03）在提交报修时仍须按同一口径复核所选公司。
   */
  async searchServiceProviderOptions(
    query: OrganizationServiceProviderOptionQuery,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<OrganizationServiceProviderOptionPage> {
    const page = Math.max(query.pagination.page, 1);
    const pageSize = Math.min(
      Math.max(query.pagination.pageSize, 1),
      SELECTOR_OPTION_PAGE_SIZE_MAX,
    );
    const keyword = query.keyword?.trim();

    const qb = this.getRepository(transactionContext)
      .createQueryBuilder('organization')
      .select(['organization.id', 'organization.name', 'organization.shortName'])
      .where('organization.status = :status', { status: 'ACTIVE' })
      .andWhere('organization.is_service_provider = :isServiceProvider', {
        isServiceProvider: true,
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
      items: rows.map((row) => ({ id: row.id, name: row.name, shortName: row.shortName })),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 管理员公司名称名单（R015 最小字段视图）：启用公司的 `id` / `name`，支持关键字与分页。
   *
   * 刻意不复用公开注册候选：本名单不按 `is_managed_company` 过滤，也不输出任何
   * 联系信息、成员或业务字段；授权由调用方按请求期管理员等级与可信公司归属裁决。
   */
  async searchOrganizationNameOptions(
    query: OrganizationNameOptionQuery,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<OrganizationNameOptionPage> {
    const page = Math.max(query.pagination.page, 1);
    const pageSize = Math.min(
      Math.max(query.pagination.pageSize, 1),
      SELECTOR_OPTION_PAGE_SIZE_MAX,
    );
    const keyword = query.keyword?.trim();

    const qb = this.getRepository(transactionContext)
      .createQueryBuilder('organization')
      .select(['organization.id', 'organization.name'])
      .where('organization.status = :status', { status: 'ACTIVE' })
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
   * 管理员公司档案完整列表（任务 08.2，一级管理员专用）。
   *
   * 关键字同时匹配全称、编号与简称（参数化 LIKE，通配符转义）；状态、受管归类与
   * 维修资格可分别筛选。按名称、主键稳定排序。本方法不裁决授权：调用方必须先经
   * `resolveLevelOneAdminScope`，二级管理员不得触达完整视图。
   */
  async searchAdminOrganizations(
    query: AdminOrganizationListQuery,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<AdminOrganizationPage> {
    const page = Math.max(query.pagination.page, 1);
    const pageSize = Math.min(
      Math.max(query.pagination.pageSize, 1),
      SELECTOR_OPTION_PAGE_SIZE_MAX,
    );
    const keyword = query.keyword?.trim();

    const qb = this.getRepository(transactionContext)
      .createQueryBuilder('organization')
      .orderBy('organization.name', 'ASC')
      .addOrderBy('organization.id', 'ASC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (keyword) {
      qb.andWhere(
        '(organization.name LIKE :keyword OR organization.organizationCode LIKE :keyword OR organization.shortName LIKE :keyword)',
        { keyword: `%${escapeLikePattern(keyword)}%` },
      );
    }
    if (query.status) {
      qb.andWhere('organization.status = :status', { status: query.status });
    }
    if (query.isManagedCompany !== undefined) {
      qb.andWhere('organization.isManagedCompany = :isManagedCompany', {
        isManagedCompany: query.isManagedCompany,
      });
    }
    if (query.isServiceProvider !== undefined) {
      qb.andWhere('organization.isServiceProvider = :isServiceProvider', {
        isServiceProvider: query.isServiceProvider,
      });
    }

    const [rows, total] = await qb.getManyAndCount();
    return {
      items: rows.map(toAdminOrganizationView),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 按主键读取公司档案完整视图（不过滤状态；停用公司仍可查看详情）。
   *
   * 授权由调用方在用例层裁决，本方法不区分管理员等级。
   */
  async findAdminOrganizationView(params: {
    organizationId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<AdminOrganizationView | null> {
    const repository = this.getRepository(params.transactionContext);
    const row = await repository.findOne({ where: { id: params.organizationId } });
    return row ? toAdminOrganizationView(row) : null;
  }

  /**
   * 事务内锁定公司档案目标行（`pessimistic_write`）并返回完整视图。
   *
   * 只允许在事务上下文中调用；用于编辑前复核目标仍存在，并在写入期间阻止并发
   * 启停或编辑交错。不存在返回 null。
   */
  async lockAdminOrganizationForUpdate(params: {
    organizationId: number;
    transactionContext: PersistenceTransactionContext;
  }): Promise<AdminOrganizationView | null> {
    const repository = this.getRepository(params.transactionContext);
    const row = await repository.findOne({
      where: { id: params.organizationId },
      lock: { mode: 'pessimistic_write' },
    });
    return row ? toAdminOrganizationView(row) : null;
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
   * 一级管理员精确同名存在性（新增 / 编辑同名提示专用）。
   *
   * 管理档案范围覆盖全部公司档案：不过滤状态、也不过滤受管归类，停用与客户手填
   * 的同名档案同样计入；编辑场景按实际主键排除自身。名称比较与注册同名提示共用
   * 同一归一化口径（见 `normalizeOrganizationNameForComparison`）。
   * 结果只用于提示，不阻断新增，也不改变同名不合并的写入语义。
   */
  async existsAnyOrganizationByName(params: {
    normalizedName: string;
    excludeOrganizationId?: number | null;
  }): Promise<boolean> {
    const queryBuilder = this.repository
      .createQueryBuilder('organization')
      .select('organization.id')
      .where(
        "LOWER(TRIM(REGEXP_REPLACE(organization.name, '\\\\s+', ' '))) COLLATE utf8mb4_0900_as_cs = :normalizedName COLLATE utf8mb4_0900_as_cs",
        { normalizedName: params.normalizedName },
      );

    if (params.excludeOrganizationId !== undefined && params.excludeOrganizationId !== null) {
      queryBuilder.andWhere('organization.id <> :excludeOrganizationId', {
        excludeOrganizationId: params.excludeOrganizationId,
      });
    }

    return (await queryBuilder.getCount()) > 0;
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
   * 按主键复核组织仍为 ACTIVE（写前复核，事务内带共享行锁）。
   *
   * 仅用于既有业务写流程在事务内复核「已归属组织是否仍有效」（当前为新建维修申请）：
   * 不要求 `is_managed_company`——补录后自由创建的未受管客户公司同样可以报修；
   * 与注册候选口径（`findEligibleRegistrationOption` 的 ACTIVE + 受管）刻意分开。
   *
   * 携带事务上下文时按当前读加共享行锁（`pessimistic_read`）：与「停用组织」的
   * UPDATE 串行。停用先提交时，本方法等锁结束后按最新提交版本判定并返回 null；
   * 本方法先取锁时，停用写入必须等本事务提交。非事务调用保持普通快照读。
   */
  async findActiveOrganizationForWrite(params: {
    organizationId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<OrganizationRegistrationOption | null> {
    const repository = this.getRepository(params.transactionContext);
    const row = await repository.findOne({
      where: { id: params.organizationId, status: 'ACTIVE' },
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

  /**
   * 按主键批量读取组织显示名称（只读，**不过滤状态**）。
   *
   * 供管理员列表在单次查询内补齐公司名，避免逐行 N+1；找不到的主键不出现在结果中，
   * 调用方按 `null` 兜底。与 `findOrganizationNameById` 同口径：只用于展示已发生的
   * 业务事实，授权与资格判定不得使用本方法。
   */
  async findOrganizationNamesByIds(
    organizationIds: readonly number[],
    transactionContext?: PersistenceTransactionContext,
  ): Promise<Map<number, string>> {
    const ids = [...new Set(organizationIds)];
    if (ids.length === 0) {
      return new Map();
    }

    const rows = await this.getRepository(transactionContext).find({
      where: { id: In(ids) },
      select: { id: true, name: true },
    });

    return new Map(rows.map((row) => [row.id, row.name]));
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

/**
 * 实体 → 管理员完整视图（字段直通，不做业务判断）。
 *
 * `kind` / `status` 的库值受 `chk_organization_kind` / `chk_organization_status`
 * 约束；此处按实体类型收窄，不引入第二套值域判断。
 */
function toAdminOrganizationView(entity: OrganizationEntity): AdminOrganizationView {
  return {
    id: entity.id,
    organizationCode: entity.organizationCode,
    name: entity.name,
    shortName: entity.shortName,
    contactName: entity.contactName,
    contactPhone: entity.contactPhone,
    contactEmail: entity.contactEmail,
    address: entity.address,
    remark: entity.remark,
    isServiceProvider: entity.isServiceProvider,
    isManagedCompany: entity.isManagedCompany,
    kind: entity.kind as AdminOrganizationView['kind'],
    status: entity.status as AdminOrganizationView['status'],
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}
