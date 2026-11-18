// src/modules/lithography/management-audit.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { PinoLogger } from 'nestjs-pino';
import { Repository } from 'typeorm';
import { ManagementAuditEventEntity } from './entities/management-audit-event.entity';

/** 本补丁新增的两类凭据管理操作（与 `chk_management_audit_operation` 同步）。 */
export type ManagementAuditOperation = 'REISSUE_LEVEL2_CREDENTIAL' | 'RESET_LEVEL2_CREDENTIAL';

/**
 * 管理审计写入服务（S3）。
 *
 * 只承担「成功事实的追加写入」：调用方必须在持有写事务时调用，插入失败直接抛错，
 * 由事务整体回滚——审计失败不得返回成功。审计行一经写入即不可变。
 *
 * 敏感约束：`detail` 只允许脱敏摘要（重置原因、脱敏登录名），绝不写入密码、哈希、
 * 派生值、Token 或完整凭据；日志也只记录操作类型与主键，不记录 detail。
 */
@Injectable()
export class ManagementAuditService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(ManagementAuditService.name);
  }

  async append(params: {
    readonly actorAccountId: number;
    readonly actorAdminLevel: number;
    readonly organizationId: number;
    readonly targetAccountId: number;
    readonly operation: ManagementAuditOperation;
    readonly transactionContext: PersistenceTransactionContext;
    /** 重置原因（补发不写） */
    readonly reason?: string;
    /** 目标账号的脱敏登录名（不得传入完整登录名以外的凭据信息） */
    readonly loginNameMasked?: string;
  }): Promise<void> {
    const repository = this.getRepository(params.transactionContext);
    const detail: { reason?: string; loginNameMasked?: string } = {
      ...(params.reason === undefined ? {} : { reason: params.reason }),
      ...(params.loginNameMasked === undefined ? {} : { loginNameMasked: params.loginNameMasked }),
    };

    await repository.insert({
      eventId: randomUUID(),
      actorAccountId: params.actorAccountId,
      actorAdminLevel: params.actorAdminLevel,
      organizationId: params.organizationId,
      operation: params.operation,
      targetType: 'ACCOUNT',
      targetId: String(params.targetAccountId),
      result: 'SUCCEEDED',
      detail: Object.keys(detail).length === 0 ? null : JSON.stringify(detail),
    });

    this.logger.info(
      {
        operation: params.operation,
        organizationId: params.organizationId,
        targetAccountId: params.targetAccountId,
      },
      '管理审计已写入',
    );
  }

  private getRepository(
    transactionContext: PersistenceTransactionContext,
  ): Repository<ManagementAuditEventEntity> {
    const manager = getTypeOrmEntityManager(transactionContext);
    return manager.getRepository(ManagementAuditEventEntity);
  }
}
