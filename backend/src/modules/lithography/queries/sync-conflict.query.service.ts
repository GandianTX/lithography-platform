// src/modules/lithography/queries/sync-conflict.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';
import { SyncConflictEntity } from '../entities/sync-conflict.entity';
import {
  type SyncConflictListFilters,
  type SyncConflictListPage,
  type SyncConflictListPagination,
  type SyncConflictSnapshot,
} from '../sync.types';

/** 冲突行 → 只读快照；不做字段级解释，快照 JSON 原样搬运 */
export function toSyncConflictSnapshot(entity: SyncConflictEntity): SyncConflictSnapshot {
  return {
    conflictId: entity.conflictId,
    recordUuid: entity.recordUuid,
    organizationId: entity.organizationId,
    resourceType: entity.resourceType,
    versionNo: entity.versionNo,
    localVersion: entity.localVersion,
    cloudVersion: entity.cloudVersion,
    displayedCloudVersion: entity.displayedCloudVersion,
    decision: (entity.decision ?? null) as SyncConflictSnapshot['decision'],
    status: entity.status as SyncConflictSnapshot['status'],
    localSnapshot: entity.localSnapshot,
    cloudSnapshot: entity.cloudSnapshot,
    conflictReason: entity.conflictReason,
    confirmedByAccountId: entity.confirmedByAccountId,
    confirmedAt: entity.confirmedAt,
    createdAt: entity.createdAt,
  };
}

/**
 * 同步冲突只读服务（任务 09 S2.1／R066）。
 *
 * 范围口径与本地运行数据一致：二级管理员与工程师只看本公司数据区，
 * 一级管理员（organizationId=null）看本设备全部公司。
 */
@Injectable()
export class SyncConflictQueryService {
  constructor(
    @InjectRepository(SyncConflictEntity)
    private readonly conflictRepository: Repository<SyncConflictEntity>,
  ) {}

  private pickRepository(
    fallback: Repository<SyncConflictEntity>,
    transactionContext?: PersistenceTransactionContext,
  ): Repository<SyncConflictEntity> {
    return transactionContext
      ? getTypeOrmEntityManager(transactionContext).getRepository(SyncConflictEntity)
      : fallback;
  }

  async listForScope(
    organizationId: number | null,
    pagination: SyncConflictListPagination,
    filters: SyncConflictListFilters = {},
    transactionContext?: PersistenceTransactionContext,
  ): Promise<SyncConflictListPage> {
    const repository = this.pickRepository(this.conflictRepository, transactionContext);
    const page = Math.max(1, Math.trunc(pagination.page));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(pagination.pageSize)));

    const builder = repository
      .createQueryBuilder('conflict')
      .orderBy('conflict.createdAt', 'DESC')
      .addOrderBy('conflict.conflictId', 'ASC')
      .take(pageSize)
      .skip((page - 1) * pageSize);

    if (organizationId !== null) {
      builder.andWhere('conflict.organizationId = :organizationId', { organizationId });
    }
    if (filters.statusOnlyPending === true) {
      builder.andWhere("conflict.status = 'PENDING'");
    }

    const items = await builder.getMany();

    let total: number | undefined;
    if (pagination.withTotal === true) {
      const countBuilder = repository.createQueryBuilder('conflict').select('COUNT(*)', 'count');
      if (organizationId !== null) {
        countBuilder.andWhere('conflict.organizationId = :organizationId', { organizationId });
      }
      if (filters.statusOnlyPending === true) {
        countBuilder.andWhere("conflict.status = 'PENDING'");
      }
      const row = await countBuilder.getRawOne<{ count: string }>();
      total = Number(row?.count ?? 0);
    }

    return {
      items: items.map(toSyncConflictSnapshot),
      total,
      page,
      pageSize,
    };
  }

  async readOne(
    conflictId: string,
    organizationId: number | null,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<SyncConflictSnapshot | null> {
    const repository = this.pickRepository(this.conflictRepository, transactionContext);
    const entity = await repository.findOne({
      where: organizationId === null ? { conflictId } : { conflictId, organizationId },
    });
    return entity ? toSyncConflictSnapshot(entity) : null;
  }
}
