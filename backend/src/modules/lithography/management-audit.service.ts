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
 * 任务 07 资料管理关键操作（R060/R061/R053 管理员作者删除；与实体 CHECK 同步）。
 *
 * 只有这三类写入本表：管理删除、归属更正、管理员以原作者身份删除。
 * 下架（R059）与普通修订（R058）只保留资料修订业务历史，不冒充关键操作。
 */
export type ManagementDocumentAuditOperation =
  'ADMIN_DELETE_DOCUMENT' | 'CORRECT_DOCUMENT_OWNERSHIP';

/**
 * 管理审计写入服务（S3）。
 *
 * 只承担「成功事实的追加写入」：调用方必须在持有写事务时调用，插入失败直接抛错，
 * 由事务整体回滚——审计失败不得返回成功。审计行一经写入即不可变。
 *
 * 敏感约束：`detail` 只允许脱敏摘要（重置原因、脱敏登录名、字段级变更摘要），
 * 绝不写入密码、哈希、派生值、Token、完整凭据或正文内容；日志也只记录操作类型
 * 与主键，不记录 detail。
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
    const detail: { reason?: string; loginNameMasked?: string } = {
      ...(params.reason === undefined ? {} : { reason: params.reason }),
      ...(params.loginNameMasked === undefined ? {} : { loginNameMasked: params.loginNameMasked }),
    };
    await this.insertEvent(
      {
        actorAccountId: params.actorAccountId,
        actorAdminLevel: params.actorAdminLevel,
        organizationId: params.organizationId,
        operation: params.operation,
        targetType: 'ACCOUNT',
        targetId: String(params.targetAccountId),
        detail,
      },
      params.transactionContext,
    );
    this.logger.info(
      {
        operation: params.operation,
        organizationId: params.organizationId,
        targetAccountId: params.targetAccountId,
      },
      '管理审计已写入',
    );
  }

  /**
   * 资料管理关键操作审计（任务 07）。
   *
   * - operation 仅限 ADMIN_DELETE_DOCUMENT / CORRECT_DOCUMENT_OWNERSHIP；
   * - organizationId 记录资料当时的归属公司（归属待核实时可为 null，列可空）；
   * - detail 仅限核实/删除原因与字段级变更摘要（from/to 为标量 ID 或状态值），
   *   不写正文、快照或存储引用。
   *
   * @throws 插入失败直接抛错，由调用方事务整体回滚（审计失败不得返回成功）。
   */
  async appendDocumentEvent(params: {
    readonly actorAccountId: number;
    readonly actorAdminLevel: number;
    readonly organizationId: number | null;
    readonly operation: ManagementDocumentAuditOperation;
    readonly targetDocumentId: number;
    readonly transactionContext: PersistenceTransactionContext;
    readonly reason: string;
    /** 字段级变更摘要（仅标量值；不写正文与快照） */
    readonly changes?: Record<string, { from: unknown; to: unknown }>;
  }): Promise<void> {
    const detail: Record<string, unknown> = { reason: params.reason };
    if (params.changes !== undefined && Object.keys(params.changes).length > 0) {
      detail.changes = params.changes;
    }
    await this.insertEvent(
      {
        actorAccountId: params.actorAccountId,
        actorAdminLevel: params.actorAdminLevel,
        organizationId: params.organizationId,
        operation: params.operation,
        targetType: 'REFERENCE_DOCUMENT',
        targetId: String(params.targetDocumentId),
        detail,
      },
      params.transactionContext,
    );
    this.logger.info(
      {
        operation: params.operation,
        targetDocumentId: params.targetDocumentId,
      },
      '资料管理审计已写入',
    );
  }

  private async insertEvent(
    event: {
      actorAccountId: number;
      actorAdminLevel: number;
      organizationId: number | null;
      operation: string;
      targetType: string;
      targetId: string;
      detail: Record<string, unknown>;
    },
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.getRepository(transactionContext);
    await repository.insert({
      eventId: randomUUID(),
      actorAccountId: event.actorAccountId,
      actorAdminLevel: event.actorAdminLevel,
      organizationId: event.organizationId,
      operation: event.operation,
      targetType: event.targetType,
      targetId: event.targetId,
      result: 'SUCCEEDED',
      detail: Object.keys(event.detail).length === 0 ? null : JSON.stringify(event.detail),
    });
  }

  private getRepository(
    transactionContext: PersistenceTransactionContext,
  ): Repository<ManagementAuditEventEntity> {
    const manager = getTypeOrmEntityManager(transactionContext);
    return manager.getRepository(ManagementAuditEventEntity);
  }
}
