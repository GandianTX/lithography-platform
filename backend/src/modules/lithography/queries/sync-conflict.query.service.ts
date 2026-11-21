// src/modules/lithography/queries/sync-conflict.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { In, Repository } from 'typeorm';
import { SyncConflictEntity } from '../entities/sync-conflict.entity';
import { type SyncConflictListFilters, type SyncConflictSnapshot } from '../sync.types';

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

/** 冲突行 → 元数据（刻意不含正文快照） */
function toSyncConflictMetadataRow(entity: SyncConflictEntity): SyncConflictMetadataRow {
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
    conflictReason: entity.conflictReason,
    confirmedByAccountId: entity.confirmedByAccountId,
    confirmedAt: entity.confirmedAt,
    createdAt: entity.createdAt,
  };
}

/**
 * 冲突**元数据**行（不含正文快照）。
 *
 * 读取路径按两段执行：先只读元数据做记录级授权裁决，授权通过后才按需取正文快照
 * （任务书 S2.2「冲突先查元数据授权再读正文」）。因此元数据行里刻意不含
 * `localSnapshot`／`cloudSnapshot`。
 */
export type SyncConflictMetadataRow = {
  conflictId: string;
  recordUuid: string;
  organizationId: number;
  resourceType: string;
  versionNo: number;
  localVersion: number | null;
  cloudVersion: number | null;
  displayedCloudVersion: number | null;
  decision: SyncConflictSnapshot['decision'];
  status: SyncConflictSnapshot['status'];
  conflictReason: string;
  confirmedByAccountId: number | null;
  confirmedAt: Date | null;
  createdAt: Date;
};

/** 冲突正文快照（仅授权通过的条目才读取） */
export type SyncConflictSnapshotPayload = {
  localSnapshot: string;
  cloudSnapshot: string;
};

/** 元数据扫描上限：超出即如实标记截断，不静默丢条目 */
export const SYNC_CONFLICT_METADATA_SCAN_LIMIT = 2000;

/**
 * 同步冲突只读服务（任务 09 S2.1／R066／后续S2）。
 *
 * 范围口径与本地运行数据一致：二级管理员与工程师只看本公司数据区，
 * 一级管理员（organizationId=null）看本设备全部公司。
 *
 * 读取拆成两段（元数据 → 快照）的原因：记录级授权必须**先于**正文读取，
 * 否则不可读记录的正文快照已经进了进程内存，授权裁决就只是形式。
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

  /**
   * 读取范围内冲突的**元数据**（不含正文快照）。
   *
   * 返回 `truncated=true` 表示候选超过扫描上限：此时可见条目集合是下界，
   * 由上层如实表达，不得当作"范围内没有更多"。
   */
  async listMetadataForScope(
    organizationId: number | null,
    filters: SyncConflictListFilters = {},
    limit: number = SYNC_CONFLICT_METADATA_SCAN_LIMIT,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<{ rows: SyncConflictMetadataRow[]; truncated: boolean }> {
    const repository = this.pickRepository(this.conflictRepository, transactionContext);
    const builder = repository
      .createQueryBuilder('conflict')
      .orderBy('conflict.createdAt', 'DESC')
      .addOrderBy('conflict.conflictId', 'ASC')
      .take(limit + 1);

    if (organizationId !== null) {
      builder.andWhere('conflict.organizationId = :organizationId', { organizationId });
    }
    if (filters.statusOnlyPending === true) {
      builder.andWhere("conflict.status = 'PENDING'");
    }

    const entities = await builder.getMany();
    const truncated = entities.length > limit;
    const rows = entities.slice(0, limit).map(toSyncConflictMetadataRow);
    return { rows, truncated };
  }

  /** 读取单条冲突的元数据（不含正文快照）；范围外与不存在同码返回 */
  async readMetadataById(
    conflictId: string,
    organizationId: number | null,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<SyncConflictMetadataRow | null> {
    const repository = this.pickRepository(this.conflictRepository, transactionContext);
    const entity = await repository.findOne({
      where: organizationId === null ? { conflictId } : { conflictId, organizationId },
      select: {
        conflictId: true,
        recordUuid: true,
        organizationId: true,
        resourceType: true,
        versionNo: true,
        localVersion: true,
        cloudVersion: true,
        displayedCloudVersion: true,
        decision: true,
        status: true,
        conflictReason: true,
        confirmedByAccountId: true,
        confirmedAt: true,
        createdAt: true,
      },
    });
    return entity === null ? null : toSyncConflictMetadataRow(entity);
  }

  /** 按冲突 ID 读取正文快照（只对授权通过的条目调用） */
  async readSnapshots(
    conflictIds: readonly string[],
    transactionContext?: PersistenceTransactionContext,
  ): Promise<Map<string, SyncConflictSnapshotPayload>> {
    const payloads = new Map<string, SyncConflictSnapshotPayload>();
    if (conflictIds.length === 0) {
      return payloads;
    }
    const repository = this.pickRepository(this.conflictRepository, transactionContext);
    const rows = await repository.find({
      where: { conflictId: In([...conflictIds]) },
      select: { conflictId: true, localSnapshot: true, cloudSnapshot: true },
    });
    for (const row of rows) {
      payloads.set(row.conflictId, {
        localSnapshot: row.localSnapshot,
        cloudSnapshot: row.cloudSnapshot,
      });
    }
    return payloads;
  }
}
