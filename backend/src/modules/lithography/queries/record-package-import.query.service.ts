// src/modules/lithography/queries/record-package-import.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';
import { RecordPackageImportEntity } from '../entities/record-package-import.entity';
import { RecordPackageItemEntity } from '../entities/record-package-item.entity';
import type {
  RecordPackageImportSnapshot,
  RecordPackageItemSnapshot,
} from '../record-package-import.types';

export function toRecordPackageImportSnapshot(
  entity: RecordPackageImportEntity,
): RecordPackageImportSnapshot {
  return {
    packageId: entity.packageId,
    organizationId: entity.organizationId,
    importedByAccountId: entity.importedByAccountId,
    manifestJson: entity.manifestJson,
    manifestChecksum: entity.manifestChecksum,
    status: entity.status,
    checkStatus: entity.checkStatus,
    itemTotal: entity.itemTotal,
    itemSucceeded: entity.itemSucceeded,
    itemFailed: entity.itemFailed,
    createdAt: entity.createdAt,
    completedAt: entity.completedAt,
  };
}

export function toRecordPackageItemSnapshot(
  entity: RecordPackageItemEntity,
): RecordPackageItemSnapshot {
  return {
    itemId: String(entity.id),
    packageId: entity.packageId,
    recordUuid: entity.recordUuid,
    resourceType: entity.resourceType,
    versionNo: entity.versionNo,
    checkResult: entity.checkResult,
    result: entity.result,
    receiptId: entity.receiptId,
    errorMessage: entity.errorMessage,
    createdAt: entity.createdAt,
  };
}

/**
 * 记录包处理结果只读服务（R073）。
 *
 * R073 边界：只看本公司本包；"已受理不是成功、检查通过不冒充实际写入"——
 * 这里只搬运事实列，不推导任何成功语义。
 */
@Injectable()
export class RecordPackageImportQueryService {
  constructor(
    @InjectRepository(RecordPackageImportEntity)
    private readonly importRepository: Repository<RecordPackageImportEntity>,
    @InjectRepository(RecordPackageItemEntity)
    private readonly itemRepository: Repository<RecordPackageItemEntity>,
  ) {}

  private pickImportRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<RecordPackageImportEntity> {
    return transactionContext
      ? getTypeOrmEntityManager(transactionContext).getRepository(RecordPackageImportEntity)
      : this.importRepository;
  }

  private pickItemRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<RecordPackageItemEntity> {
    return transactionContext
      ? getTypeOrmEntityManager(transactionContext).getRepository(RecordPackageItemEntity)
      : this.itemRepository;
  }

  async readImport(
    packageId: string,
    organizationId: number | null,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<RecordPackageImportSnapshot | null> {
    const entity = await this.pickImportRepository(transactionContext).findOne({
      where: organizationId === null ? { packageId } : { packageId, organizationId },
    });
    return entity ? toRecordPackageImportSnapshot(entity) : null;
  }

  async listItems(
    packageId: string,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<RecordPackageItemSnapshot[]> {
    const rows = await this.pickItemRepository(transactionContext).find({
      where: { packageId },
      order: { id: 'ASC' },
    });
    return rows.map(toRecordPackageItemSnapshot);
  }
}
