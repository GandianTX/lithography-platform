// src/modules/lithography/engineer-registration.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import { DomainError, ENGINEER_REGISTRATION_ERROR } from '@core/common/errors';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';
import { isDuplicateKeyError } from './database-error.helpers';
import { EngineerRegistrationApplicationEntity } from './entities/engineer-registration-application.entity';
import { toEngineerRegistrationApplicationSnapshot } from './engineer-registration.mapper';
import {
  EngineerRegistrationApplicationInsertData,
  EngineerRegistrationApplicationSnapshot,
  EngineerRegistrationDecisionUpdateData,
} from './engineer-registration.types';

/**
 * 工程师自助注册申请写服务。
 *
 * 职责：
 * - 新增一份待审申请（初始状态固定为 PENDING，审核字段全部为空）；
 * - 审批 / 重提流程所需的行锁读取与终态决策写入；
 * - 同一账号的「最多一份待审申请」由生成列唯一键兜底，冲突在本层收敛为
 *   `PENDING_APPLICATION_EXISTS`，业务裁决（何时可提交）仍归 usecase。
 *
 * 不包含：
 * - 账号创建、组织有效性核验、审批权限与锁序编排（归 usecase）；
 * - 事务开启（事务边界由 usecase 通过 TransactionRunner 持有）；
 * - 锁序策略：调用方必须先锁账号行、再调用本层的申请行锁方法。
 */
@Injectable()
export class EngineerRegistrationService {
  constructor(
    @InjectRepository(EngineerRegistrationApplicationEntity)
    private readonly repository: Repository<EngineerRegistrationApplicationEntity>,
  ) {}

  /**
   * 插入待审申请。
   *
   * `pending_account_id` 为数据库生成列，不参与写入；需要完整视图时由调用方在
   * 同一事务内经只读 QueryService 回读，避免在本层用推断值充当数据库事实。
   */
  async insertApplication(
    data: EngineerRegistrationApplicationInsertData,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<{ applicationId: number }> {
    const repository = this.getRepository(transactionContext);
    const entity = repository.create({
      accountId: data.accountId,
      organizationId: data.organizationId,
      status: EngineerRegistrationApplicationStatus.PENDING,
      applicationNote: data.applicationNote,
      submittedAt: data.submittedAt,
      reviewedByAccountId: null,
      reviewedAt: null,
      reviewComment: null,
    });
    try {
      const saved = await repository.save(entity);
      return { applicationId: saved.id };
    } catch (error) {
      // 生成列唯一键冲突 = 同一账号并发提交了第二份待审申请
      if (isDuplicateKeyError(error)) {
        throw new DomainError(
          ENGINEER_REGISTRATION_ERROR.PENDING_APPLICATION_EXISTS,
          '已有待审核的注册申请，请等待审核结果',
          undefined,
          error,
        );
      }
      throw new DomainError(
        ENGINEER_REGISTRATION_ERROR.WRITE_FAILED,
        '注册申请提交失败，请稍后重试',
        undefined,
        error,
      );
    }
  }

  /**
   * 锁定并读取账号最新一份申请（pessimistic_write）。
   *
   * 供重提流程在同一事务内、已先锁定账号行之后使用：锁序统一为
   * 「账号行锁在前、申请行锁在后」，审批与重提共用同一顺序，避免死锁。
   *
   * @param transactionContext 事务上下文（必须与后续写入同事务，否则锁立即释放）
   * @returns 最新申请快照；无历史申请时为 null
   */
  async lockLatestApplicationByAccountId(
    accountId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<EngineerRegistrationApplicationSnapshot | null> {
    try {
      const entity = await this.getRepository(transactionContext).findOne({
        where: { accountId },
        order: { id: 'DESC' },
        lock: { mode: 'pessimistic_write' },
      });
      return entity ? toEngineerRegistrationApplicationSnapshot(entity) : null;
    } catch (error) {
      throw new DomainError(
        ENGINEER_REGISTRATION_ERROR.READ_FAILED,
        '注册申请读取失败，请稍后重试',
        undefined,
        error,
      );
    }
  }

  /**
   * 锁定并读取指定申请（pessimistic_write）。
   *
   * 供审批流程使用；调用方必须已先锁定申请人账号行。归属与组织边界裁决归 usecase。
   *
   * @returns 申请快照；不存在时为 null
   */
  async lockApplicationById(
    applicationId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<EngineerRegistrationApplicationSnapshot | null> {
    try {
      const entity = await this.getRepository(transactionContext).findOne({
        where: { id: applicationId },
        lock: { mode: 'pessimistic_write' },
      });
      return entity ? toEngineerRegistrationApplicationSnapshot(entity) : null;
    } catch (error) {
      throw new DomainError(
        ENGINEER_REGISTRATION_ERROR.READ_FAILED,
        '注册申请读取失败，请稍后重试',
        undefined,
        error,
      );
    }
  }

  /**
   * 写入一次终态审核决策（只允许从 PENDING 迁出）。
   *
   * 条件更新 `status = PENDING`：并发第二次决策的 `affected` 为 0，
   * 由 usecase 统一收敛为 `APPLICATION_STATE_CONFLICT`，本层不猜测业务语义。
   * 不覆盖历史行、不创建新申请行：拒绝后重提由 usecase 另插一份新 PENDING 记录，
   * 原审核记录（含拒绝意见）永久保留。
   *
   * @returns `updated` 表示条件更新是否命中；未命中即申请已不再是待审态
   */
  async updateApplicationDecision(
    data: EngineerRegistrationDecisionUpdateData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<{ updated: boolean }> {
    try {
      const result = await this.getRepository(transactionContext).update(
        {
          id: data.applicationId,
          status: EngineerRegistrationApplicationStatus.PENDING,
        },
        {
          status: data.status,
          reviewedByAccountId: data.reviewedByAccountId,
          reviewedAt: data.reviewedAt,
          reviewComment: data.reviewComment,
        },
      );
      return { updated: (result.affected ?? 0) > 0 };
    } catch (error) {
      throw new DomainError(
        ENGINEER_REGISTRATION_ERROR.WRITE_FAILED,
        '审核结果写入失败，请稍后重试',
        { applicationId: data.applicationId },
        error,
      );
    }
  }

  private getRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<EngineerRegistrationApplicationEntity> {
    const manager = transactionContext ? getTypeOrmEntityManager(transactionContext) : undefined;
    return manager ? manager.getRepository(EngineerRegistrationApplicationEntity) : this.repository;
  }
}
