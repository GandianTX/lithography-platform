// src/modules/lithography/sync-conflict.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { In, Repository } from 'typeorm';
import { LocalAccountAuthorizationEntity } from './entities/local-account-authorization.entity';
import { SyncConflictEntity } from './entities/sync-conflict.entity';
import { SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import { toSyncConflictSnapshot } from './queries/sync-conflict.query.service';
import type { SyncConflictResolveCommand, SyncConflictSnapshot } from './sync.types';
import {
  type LocalAuthorizationRenewalInput,
  type LocalAuthorizationRenewalScope,
  validateAuthorizationRenewalInput,
} from '@core/local-runtime/policy/local-authorization-renewal.policy';

/**
 * 同步冲突与本地授权写服务（任务 09 S2.1／S2.2）。
 *
 * 冲突裁决（R067／R068／R069）：
 * - 全部走「锁读 → 判定 → 条件更新」：`WHERE status='PENDING'` 的条件更新是
 *   与 CHECK（PENDING ⇒ 确认人为空）一致的守门方式；
 * - 重复相同方向返回既有事实，不重复写、不生成第二个修订；
 * - 换方向显式拒绝，不静默覆盖；
 * - 稍后处理不写任何字段；
 * - `LOCAL` 裁决需要 04/06/07 受控版本写入入口（X04），本服务不做业务规则重写，
 *   未接入前由 core 策略显式失败。
 */
@Injectable()
export class SyncConflictService {
  constructor(
    @InjectRepository(SyncConflictEntity)
    private readonly conflictRepository: Repository<SyncConflictEntity>,
    @InjectRepository(LocalAccountAuthorizationEntity)
    private readonly authorizationRepository: Repository<LocalAccountAuthorizationEntity>,
  ) {}

  private pickConflictRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<SyncConflictEntity> {
    return transactionContext
      ? getTypeOrmEntityManager(transactionContext).getRepository(SyncConflictEntity)
      : this.conflictRepository;
  }

  private pickAuthorizationRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<LocalAccountAuthorizationEntity> {
    return transactionContext
      ? getTypeOrmEntityManager(transactionContext).getRepository(LocalAccountAuthorizationEntity)
      : this.authorizationRepository;
  }

  /** 锁读：裁决与续期都要求先锁定行，避免并发裁决互相覆盖确认人 */
  async lockConflict(
    conflictId: string,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<SyncConflictEntity | null> {
    return this.pickConflictRepository(transactionContext)
      .createQueryBuilder('conflict')
      .setLock('pessimistic_write')
      .where('conflict.conflictId = :conflictId', { conflictId })
      .getOne();
  }

  async readConflictById(
    conflictId: string,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<SyncConflictSnapshot | null> {
    const entity = await this.pickConflictRepository(transactionContext).findOne({
      where: { conflictId },
    });
    return entity ? toSyncConflictSnapshot(entity) : null;
  }

  /**
   * 条件更新：只允许从 PENDING 落到 RESOLVED。
   * 返回受影响行数——0 表示并发期间已被其他会话裁决，调用方据以回读既有事实。
   */
  async applyCloudResolution(
    command: SyncConflictResolveCommand,
    confirmedAt: Date,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<number> {
    const repository = this.pickConflictRepository(transactionContext);
    const result = await repository
      .createQueryBuilder()
      .update(SyncConflictEntity)
      .set({
        decision: 'CLOUD',
        status: 'RESOLVED',
        confirmedByAccountId: command.confirmedByAccountId,
        confirmedAt,
      })
      .where('conflictId = :conflictId AND status = :status', {
        conflictId: command.conflictId,
        status: 'PENDING',
      })
      .execute();
    return result.affected ?? 0;
  }

  /**
   * 同公司授权续期（R065：续期只更新凭据与有效期，不动队列）。
   *
   * - 范围键（安装＋账号＋公司）必须与既有行完全一致；
   * - 仅 ACTIVE 行可续期，REVOKED 必须重新授权；
   * - 更新只写 `signed_claims`／`permission_version`／`last_verified_at`。
   */
  async renewAccountAuthorization(
    scope: LocalAuthorizationRenewalScope,
    input: LocalAuthorizationRenewalInput,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<{ renewedAuthorizationId: string }> {
    validateAuthorizationRenewalInput(input);

    const repository = this.pickAuthorizationRepository(transactionContext);
    const row = await repository
      .createQueryBuilder('authorization')
      .setLock('pessimistic_write')
      .where(
        'authorization.installationId = :installationId AND authorization.accountId = :accountId AND authorization.organizationId = :organizationId',
        scope,
      )
      .getOne();

    if (!row) {
      throw new DomainError(SYNC_ERROR.AUTHORIZATION_NOT_FOUND, '本机授权记录不存在');
    }
    if (row.authorizationStatus !== 'ACTIVE') {
      throw new DomainError(
        SYNC_ERROR.AUTHORIZATION_RENEWAL_NOT_ALLOWED,
        '已撤销授权不能续期，必须重新授权',
      );
    }

    row.signedClaims = input.signedClaims;
    row.permissionVersion = input.permissionVersion;
    row.lastVerifiedAt = input.lastVerifiedAt;
    await repository.save(row);

    return { renewedAuthorizationId: String(row.id) };
  }

  /** 批量按主键读取（供 usecase 校验裁决后事实），仅限同一次调用内部使用 */
  async readConflictsByIds(
    conflictIds: readonly string[],
    transactionContext?: PersistenceTransactionContext,
  ): Promise<SyncConflictSnapshot[]> {
    if (conflictIds.length === 0) {
      return [];
    }
    const rows = await this.pickConflictRepository(transactionContext).find({
      where: { conflictId: In([...conflictIds]) },
    });
    return rows.map(toSyncConflictSnapshot);
  }
}
