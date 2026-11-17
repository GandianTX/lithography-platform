// src/modules/lithography/repair-process-entry.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { randomUUID } from 'node:crypto';
import { DomainError, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { FindOptionsWhere, IsNull, Repository } from 'typeorm';
import { RepairProcessEntryEntity } from './entities/repair-process-entry.entity';
import { RepairProcessEntrySnapshot } from './lithography.types';

type RepairProcessEntryInsertData = {
  requestId: number;
  authorAccountId: number;
  operationText: string;
  testResult: string | null;
  occurredAt: Date | null;
  timeSource: string;
  fileId: string | null;
};

type RepairProcessEntryUpdateData = {
  requestId: number;
  entryId: string;
  authorAccountId: number;
  expectedVersion: number;
  operationText: string;
  testResult: string | null;
  occurredAt: Date | null;
  timeSource: string;
  /**
   * 仅在当前过程无原件、需补传绑定新原件时传入。
   * 省略表示保持原 file_id 不变；传入时条件更新同时要求 file_id 仍为 NULL。
   */
  fileId?: string;
};

/**
 * 内部维修过程写服务。
 *
 * 职责范围：
 * - 过程记录插入（初始版本号 1，稳定记录编号由服务端生成）
 * - 过程记录行锁读（作者/版本校验前的最小事实）
 * - 按版本号条件更新（命中行数不符即并发冲突，由 usecase 裁决错误）
 *
 * 不包含：权限、工单状态、作者归属等业务裁决，均由 usecase 在同一事务内完成；
 * 过程列表读取归 `RepairProcessEntryQueryService`（读侧）。
 */
@Injectable()
export class RepairProcessEntryService {
  constructor(
    @InjectRepository(RepairProcessEntryEntity)
    private readonly repository: Repository<RepairProcessEntryEntity>,
  ) {}

  async insertEntry(
    data: RepairProcessEntryInsertData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<RepairProcessEntrySnapshot> {
    const repository = this.getRepository(transactionContext);
    try {
      const entity = repository.create({
        entryUuid: randomUUID(),
        requestId: data.requestId,
        authorAccountId: data.authorAccountId,
        operationText: data.operationText,
        testResult: data.testResult,
        occurredAt: data.occurredAt,
        timeSource: data.timeSource,
        fileId: data.fileId,
        versionNo: 1,
        createdAt: new Date(),
      });
      const saved = await repository.save(entity);
      return this.toSnapshot(saved);
    } catch (error) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.PROCESS_WRITE_FAILED,
        '内部维修过程保存失败，请稍后重试',
        { requestId: data.requestId },
        error,
      );
    }
  }

  async findForUpdate(
    requestId: number,
    entryId: string,
    transactionContext: PersistenceTransactionContext,
  ): Promise<RepairProcessEntrySnapshot | null> {
    const repository = this.getRepository(transactionContext);
    const entity = await repository.findOne({
      where: { id: entryId, requestId },
      lock: { mode: 'pessimistic_write' },
    });
    return entity ? this.toSnapshot(entity) : null;
  }

  /**
   * 按 `(id, request_id, author_account_id, version_no)` 条件更新并递增版本号。
   * 补传原件时额外约束 `file_id IS NULL` 并写入新 fileId，避免覆盖既有原件。
   * 返回命中行数；0 表示作者/版本/原件占位在读取后被并发改变，由 usecase 映射冲突。
   */
  async updateWithVersion(
    data: RepairProcessEntryUpdateData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<number> {
    const repository = this.getRepository(transactionContext);
    try {
      const criteria: FindOptionsWhere<RepairProcessEntryEntity> = {
        id: data.entryId,
        requestId: data.requestId,
        authorAccountId: data.authorAccountId,
        versionNo: data.expectedVersion,
        ...(data.fileId !== undefined ? { fileId: IsNull() } : {}),
      };
      const result = await repository.update(criteria, {
        operationText: data.operationText,
        testResult: data.testResult,
        occurredAt: data.occurredAt,
        timeSource: data.timeSource,
        versionNo: () => 'version_no + 1',
        ...(data.fileId !== undefined ? { fileId: data.fileId } : {}),
      });
      return result.affected ?? 0;
    } catch (error) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.PROCESS_WRITE_FAILED,
        '内部维修过程保存失败，请稍后重试',
        { requestId: data.requestId },
        error,
      );
    }
  }

  private toSnapshot(entity: RepairProcessEntryEntity): RepairProcessEntrySnapshot {
    return {
      id: String(entity.id),
      entryUuid: entity.entryUuid,
      requestId: entity.requestId,
      authorAccountId: entity.authorAccountId,
      operationText: entity.operationText,
      testResult: entity.testResult,
      occurredAt: entity.occurredAt,
      timeSource: entity.timeSource,
      fileId: entity.fileId,
      versionNo: entity.versionNo,
      createdAt: entity.createdAt,
    };
  }

  private getRepository(
    transactionContext: PersistenceTransactionContext,
  ): Repository<RepairProcessEntryEntity> {
    const manager = getTypeOrmEntityManager(transactionContext);
    return manager.getRepository(RepairProcessEntryEntity);
  }
}
