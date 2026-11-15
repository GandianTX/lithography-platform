// src/modules/lithography/stored-file.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { StoredFileBindingStatus, StoredFileStatus } from '@app-types/models/stored-file.types';
import { DomainError, STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { IsNull, Repository } from 'typeorm';
import { StoredFileEntity } from './entities/stored-file.entity';
import { StoredFileInsertData, StoredFileSnapshot } from './lithography.types';

/**
 * 共用业务原件写服务。
 *
 * 职责范围：
 * - 暂存登记（VALID + TEMPORARY + business_id 为空）
 * - 绑定前锁定读取（pessimistic_write，供 usecase 在同一事务内核对事实）
 * - 原子条件绑定（仅 VALID + TEMPORARY + business_id 为空，单条 UPDATE 串行化并发）
 *
 * 不包含：
 * - 权限判断、上传者/公司/用途/上下文裁决、工单状态裁决（归 usecase）
 * - 事务开启（任务 04 保存用例通过 TransactionRunner 持有事务并传入上下文）
 */
@Injectable()
export class StoredFileService {
  constructor(
    @InjectRepository(StoredFileEntity)
    private readonly repository: Repository<StoredFileEntity>,
  ) {}

  /** 登记暂存原件；写入完成即 VALID（已校验）但仍是 TEMPORARY（未绑定） */
  async insertStagedFile(
    data: StoredFileInsertData,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<StoredFileSnapshot> {
    const repository = this.getRepository(transactionContext);
    try {
      const entity = repository.create({
        fileId: data.fileId,
        uploadedByAccountId: data.uploadedByAccountId,
        ownerOrganizationId: data.ownerOrganizationId,
        storageReference: data.storageReference,
        originalFilename: data.originalFilename,
        mimeType: data.mimeType,
        byteSize: String(data.byteSize),
        checksumSha256: data.checksumSha256,
        status: StoredFileStatus.VALID,
        businessType: data.businessType,
        businessId: null,
        uploadContextId: data.uploadContextId,
        bindingStatus: StoredFileBindingStatus.TEMPORARY,
        verifiedAt: new Date(),
      });
      const saved = await repository.save(entity);
      return this.toSnapshot(saved);
    } catch (error) {
      throw new DomainError(
        STORED_FILE_ERROR.UPLOAD_FAILED,
        '原件暂存失败，请稍后重试',
        { fileId: data.fileId },
        error,
      );
    }
  }

  /**
   * 绑定前锁定读取（必须在任务 04 保存事务内调用）：
   * 行锁串行化「核对原件事实 → 条件绑定」，防止并发保存重复占用同一原件。
   */
  async lockForBinding(
    fileId: string,
    transactionContext: PersistenceTransactionContext,
  ): Promise<StoredFileSnapshot | null> {
    const repository = this.getRepository(transactionContext);
    try {
      const entity = await repository.findOne({
        where: { fileId },
        lock: { mode: 'pessimistic_write' },
      });
      return entity ? this.toSnapshot(entity) : null;
    } catch (error) {
      throw new DomainError(
        STORED_FILE_ERROR.BIND_FAILED,
        '原件绑定失败，请稍后重试',
        { fileId },
        error,
      );
    }
  }

  /**
   * 原子条件绑定：仅 VALID + TEMPORARY + business_id 为空可命中。
   * 返回条件更新命中行数；0 表示已被占用/状态已变，由 usecase 裁决冲突。
   */
  async bindIfTemporary(
    params: {
      fileId: string;
      businessType: string;
      businessId: string;
    },
    transactionContext: PersistenceTransactionContext,
  ): Promise<number> {
    const repository = this.getRepository(transactionContext);
    try {
      const result = await repository.update(
        {
          fileId: params.fileId,
          status: StoredFileStatus.VALID,
          bindingStatus: StoredFileBindingStatus.TEMPORARY,
          businessId: IsNull(),
        },
        {
          businessType: params.businessType,
          businessId: params.businessId,
          bindingStatus: StoredFileBindingStatus.BOUND,
        },
      );
      return result.affected ?? 0;
    } catch (error) {
      throw new DomainError(
        STORED_FILE_ERROR.BIND_FAILED,
        '原件绑定失败，请稍后重试',
        { fileId: params.fileId },
        error,
      );
    }
  }

  private toSnapshot(entity: StoredFileEntity): StoredFileSnapshot {
    return {
      fileId: entity.fileId,
      uploadedByAccountId: entity.uploadedByAccountId,
      ownerOrganizationId: entity.ownerOrganizationId,
      storageReference: entity.storageReference,
      originalFilename: entity.originalFilename,
      mimeType: entity.mimeType,
      byteSize: Number(entity.byteSize),
      checksumSha256: entity.checksumSha256,
      status: entity.status,
      businessType: entity.businessType,
      businessId: entity.businessId,
      uploadContextId: entity.uploadContextId,
      bindingStatus: entity.bindingStatus,
      createdAt: entity.createdAt,
      verifiedAt: entity.verifiedAt,
    };
  }

  private getRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<StoredFileEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(StoredFileEntity) : this.repository;
  }
}
