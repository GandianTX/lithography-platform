// src/modules/lithography/queries/engineer-registration.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';
import { EngineerRegistrationApplicationEntity } from '../entities/engineer-registration-application.entity';
import { toEngineerRegistrationApplicationSnapshot } from '../engineer-registration.mapper';
import {
  EngineerRegistrationApplicationSnapshot,
  EngineerRegistrationListPage,
  EngineerRegistrationListPagination,
  EngineerRegistrationOrganizationQueueQuery,
} from '../engineer-registration.types';

/**
 * 工程师自助注册申请读取服务。
 *
 * 只返回申请记录的安全视图：不含凭据、角色摘要或其他账号资料。
 * 本服务收到的 `accountId` / `applicationId` 必须由 usecase 认证并解析为本人作用域后传入，
 * 禁止把 adapter 外部输入直接透传；可见范围裁决与写侧流程授权归 usecase。
 * QueryService 只做普通读，不加锁、不写入；需要「锁后复核申请仍 PENDING」的审批/重提流程，
 * 必须由 usecase 先对账号行加锁，再在同一事务内调用本服务读取。
 */
@Injectable()
export class EngineerRegistrationQueryService {
  constructor(
    @InjectRepository(EngineerRegistrationApplicationEntity)
    private readonly repository: Repository<EngineerRegistrationApplicationEntity>,
  ) {}

  async findById(
    applicationId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<EngineerRegistrationApplicationSnapshot | null> {
    const entity = await this.getRepository(transactionContext).findOne({
      where: { id: applicationId },
    });
    return entity ? toEngineerRegistrationApplicationSnapshot(entity) : null;
  }

  /** 读取账号最新一份申请（不区分状态），供重提流程判断是否存在可重提的拒绝记录 */
  async findLatestByAccountId(
    accountId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<EngineerRegistrationApplicationSnapshot | null> {
    const entity = await this.getRepository(transactionContext).findOne({
      where: { accountId },
      order: { id: 'DESC' },
    });
    return entity ? toEngineerRegistrationApplicationSnapshot(entity) : null;
  }

  /** 组织审核队列：按提交时间正序（先到先审），只含指定组织的申请 */
  async listByOrganization(
    query: EngineerRegistrationOrganizationQueueQuery,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<EngineerRegistrationListPage> {
    const page = Math.max(query.pagination.page, 1);
    const pageSize = Math.max(query.pagination.pageSize, 1);
    const where = {
      organizationId: query.organizationId,
      ...(query.status === undefined ? {} : { status: query.status }),
    };
    const [entities, total] = await this.getRepository(transactionContext).findAndCount({
      where,
      order: { submittedAt: 'ASC', id: 'ASC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      items: entities.map(toEngineerRegistrationApplicationSnapshot),
      page,
      pageSize,
      total,
    };
  }

  /** 本人申请历史：按提交时间倒序，供本人状态查询展示，不含其他账号记录 */
  async listByAccountId(
    accountId: number,
    pagination: EngineerRegistrationListPagination,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<EngineerRegistrationListPage> {
    // 下限归一并回显实际值；页码/页大小上限与业务范围由 usecase/adapter 输入校验负责
    const page = Math.max(pagination.page, 1);
    const pageSize = Math.max(pagination.pageSize, 1);
    const [entities, total] = await this.getRepository(transactionContext).findAndCount({
      where: { accountId },
      order: { submittedAt: 'DESC', id: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      items: entities.map(toEngineerRegistrationApplicationSnapshot),
      page,
      pageSize,
      total,
    };
  }

  private getRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<EngineerRegistrationApplicationEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(EngineerRegistrationApplicationEntity) : this.repository;
  }
}
