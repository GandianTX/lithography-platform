// src/modules/lithography/stored-file.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { StoredFileBindingStatus, StoredFileStatus } from '@app-types/models/stored-file.types';
import { DomainError, STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { In, IsNull, Repository } from 'typeorm';
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

  /**
   * 解除绑定（仅替换原件同事务使用）：仅当原件当前 BOUND 到指定业务时恢复 TEMPORARY。
   * 返回命中行数；0 表示绑定状态已变化（如已被并发改写），由调用方裁决是否容错。
   */
  async unbindIfBoundTo(
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
          bindingStatus: StoredFileBindingStatus.BOUND,
          businessType: params.businessType,
          businessId: params.businessId,
        },
        {
          bindingStatus: StoredFileBindingStatus.TEMPORARY,
          businessId: null,
        },
      );
      return result.affected ?? 0;
    } catch (error) {
      throw new DomainError(
        STORED_FILE_ERROR.BIND_FAILED,
        '原件解除绑定失败，请稍后重试',
        { fileId: params.fileId },
        error,
      );
    }
  }

  /**
   * **精确释放**暂存原件（补偿用）：仅 VALID + TEMPORARY + business_id 为空的行可命中。
   *
   * 用途：调用方自己登记的暂存原件在后续步骤失败（绑定失败／业务写失败）时，
   * 把这些"已登记但永远不会被绑定"的行标记为 `FAILED`——
   * **行保留（可追踪：fileId／上传者／归属公司／摘要仍在）、不物理删行、不动字节**。
   *
   * 命中条件自带"只处理自己范围内"的闸门：
   * - 只处理调用方**指名**的 fileId（不按条件批量扫）；
   * - 只处理**未被任何业务绑定**的行 → 不会动已绑定的既有原件；
   * - 已绑定（BOUND）或已失效（FAILED/STAGING）的行不命中 → 不会动他人／他公司的对象。
   *
   * 返回命中行数（0 表示这些行已被绑定或状态已变化，由调用方按"保留"处理）。
   */
  async releaseTemporaryFiles(
    params: { fileIds: string[] },
    transactionContext?: PersistenceTransactionContext,
  ): Promise<number> {
    if (params.fileIds.length === 0) {
      return 0;
    }
    const repository = this.getRepository(transactionContext);
    try {
      const result = await repository.update(
        {
          fileId: In(params.fileIds),
          status: StoredFileStatus.VALID,
          bindingStatus: StoredFileBindingStatus.TEMPORARY,
          businessId: IsNull(),
        },
        {
          status: StoredFileStatus.FAILED,
        },
      );
      return result.affected ?? 0;
    } catch (error) {
      throw new DomainError(
        STORED_FILE_ERROR.BIND_FAILED,
        '暂存原件释放失败，请稍后重试',
        { fileIds: params.fileIds },
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
