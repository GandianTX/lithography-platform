// src/modules/lithography/admin-organization-provisioning.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, ORGANIZATION_MANAGEMENT_ERROR } from '@core/common/errors/domain-error';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import {
  findDuplicateKeyName,
  isDuplicateKeyError,
} from '@src/modules/common/utils/database-error.util';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminOrganizationProvisioningRequestEntity } from './entities/admin-organization-provisioning-request.entity';

/** 提交标识唯一键；并发与重试的串行点。 */
const SUBMISSION_UNIQUE_INDEX = 'uk_provisioning_purpose_actor_key';

/** 提交标识状态：只允许 PENDING → COMPLETED 单向。 */
export type ProvisioningRequestState = 'PENDING' | 'COMPLETED';

/**
 * 提交标识窄事实（不返回 ORM Entity）。
 *
 * `inputFingerprint` 只承载规范化输入的 SHA-256，不含任何原始输入或凭据。
 */
export type ProvisioningRequestFact = {
  readonly id: number;
  readonly inputFingerprint: string;
  readonly state: ProvisioningRequestState;
  readonly organizationId: number | null;
  readonly adminAccountId: number | null;
};

/**
 * 同一（用途 + 操作者 + 提交标识）已存在时的信号。
 *
 * 竞争失败者据此在事务外回读已提交行并比较指纹；本错误不携带任何业务引用，
 * 避免把「另一请求正在开通什么」泄露给调用方。
 */
export class DuplicateProvisioningRequestError extends Error {
  constructor() {
    super('提交标识已被占用，需要回读已提交结果');
    this.name = 'DuplicateProvisioningRequestError';
  }
}

/** 判断重复键是否命中提交标识唯一键（驱动可能返回裸索引名或 `table.index` 形式）。 */
function isSubmissionUniqueIndexViolation(error: unknown): boolean {
  const keyName = findDuplicateKeyName(error);
  if (keyName === null) {
    return false;
  }
  return keyName === SUBMISSION_UNIQUE_INDEX || keyName.endsWith(`.${SUBMISSION_UNIQUE_INDEX}`);
}

/**
 * 一级管理员新增公司开通提交标识读写服务。
 *
 * 写入口径：
 * - `reserve()` 必须在业务事务的**第一条语句**执行：唯一键即串行点，
 *   后到事务阻塞至先到事务提交/回滚；
 * - `complete()` 在同一事务内补全公司与账号引用，状态置 `COMPLETED`；
 * - 表内不保存任何密码、哈希或令牌。
 */
@Injectable()
export class AdminOrganizationProvisioningService {
  constructor(
    @InjectRepository(AdminOrganizationProvisioningRequestEntity)
    private readonly repository: Repository<AdminOrganizationProvisioningRequestEntity>,
  ) {}

  /**
   * 预留提交标识。
   *
   * @returns 提交行主键
   * @throws DuplicateProvisioningRequestError 同（用途 + 操作者 + 标识）已存在
   * @throws DomainError 其他唯一键冲突或写入失败
   */
  async reserve(params: {
    purpose: string;
    submissionKey: string;
    actorAccountId: number;
    inputFingerprint: string;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<number> {
    const repository = this.getRepository(params.transactionContext);

    try {
      const result = await repository.insert({
        purpose: params.purpose,
        submissionKey: params.submissionKey,
        actorAccountId: params.actorAccountId,
        inputFingerprint: params.inputFingerprint,
        state: 'PENDING',
      });
      const identifier = result.identifiers[0]?.id as number | undefined;
      if (typeof identifier !== 'number' || !Number.isInteger(identifier) || identifier <= 0) {
        throw new DomainError(
          ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
          '提交标识预留失败，请稍后重试',
          undefined,
          { diagnostic: 'PROVISIONING_RESERVE_MISSING_ID' },
        );
      }
      return identifier;
    } catch (error) {
      if (isSubmissionUniqueIndexViolation(error)) {
        throw new DuplicateProvisioningRequestError();
      }
      if (isDuplicateKeyError(error)) {
        throw new DomainError(
          ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
          '提交标识预留失败，请稍后重试',
          undefined,
          error,
        );
      }
      throw error;
    }
  }

  /**
   * 在预留行上补全公司/账号引用并置 `COMPLETED`。
   *
   * 必须在与 `reserve()` 相同的事务内调用；引用与状态同成同败。
   */
  async complete(params: {
    requestId: number;
    organizationId: number;
    adminAccountId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<void> {
    const repository = this.getRepository(params.transactionContext);
    const result = await repository.update(
      { id: params.requestId },
      {
        organizationId: params.organizationId,
        adminAccountId: params.adminAccountId,
        state: 'COMPLETED',
        updatedAt: new Date(),
      },
    );

    if (result.affected !== 1) {
      throw new DomainError(
        ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
        '提交标识完成状态写入失败，请稍后重试',
        undefined,
        { diagnostic: 'PROVISIONING_COMPLETE_NOT_APPLIED', requestId: params.requestId },
      );
    }
  }

  /**
   * 按（用途 + 提交标识 + 操作者）读取窄事实。
   *
   * 返回 `null` 表示尚无该提交标识；调用方负责指纹与回放校验。
   */
  async findByKey(params: {
    purpose: string;
    submissionKey: string;
    actorAccountId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<ProvisioningRequestFact | null> {
    const repository = this.getRepository(params.transactionContext);
    const entity = await repository.findOne({
      where: {
        purpose: params.purpose,
        submissionKey: params.submissionKey,
        actorAccountId: params.actorAccountId,
      },
    });

    if (entity === null) {
      return null;
    }

    return {
      id: entity.id,
      inputFingerprint: entity.inputFingerprint,
      state: entity.state === 'COMPLETED' ? 'COMPLETED' : 'PENDING',
      organizationId: entity.organizationId,
      adminAccountId: entity.adminAccountId,
    };
  }

  private getRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<AdminOrganizationProvisioningRequestEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager
      ? manager.getRepository(AdminOrganizationProvisioningRequestEntity)
      : this.repository;
  }
}
