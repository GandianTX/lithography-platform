import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, MANAGEMENT_AUDIT_ERROR } from '@core/common/errors/domain-error';
import {
  serializeManagementAuditDetail,
  type ManagementAuditDetailView,
} from '@core/management-audit/policy/management-audit-detail.policy';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { PinoLogger } from 'nestjs-pino';
import { Repository } from 'typeorm';
import { ManagementAuditEventEntity } from './entities/management-audit-event.entity';
import {
  isManagementAuditQueryOperation,
  isManagementAuditResultValue,
  type ManagementAuditQueryOperation,
  type ManagementAuditResultValue,
} from './management-audit.types';

/** 本补丁新增的两类凭据管理操作（与 `chk_management_audit_operation` 同步）。 */
export type ManagementAuditOperation = 'REISSUE_LEVEL2_CREDENTIAL' | 'RESET_LEVEL2_CREDENTIAL';

/** targetType 只接受大写标识，长度与 `varchar(32)` 对齐。 */
const TARGET_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;
/** targetId 与 `varchar(64)` 对齐，禁止控制字符。 */
const MAX_TARGET_ID_LENGTH = 64;

/** 目标 ID 是否含控制字符（用码点判断，避免 no-control-regex 的误报来源）。 */
const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

/** 三类业务事实的写入参数（07／09 共用）。 */
export type ManagementAuditBusinessOperationParams = {
  readonly actorAccountId: number;
  readonly actorAdminLevel: number;
  readonly organizationId: number | null;
  readonly operation: ManagementAuditQueryOperation;
  readonly targetType: string;
  readonly targetId: string;
  readonly result: ManagementAuditResultValue;
  readonly transactionContext: PersistenceTransactionContext;
  readonly detail?: ManagementAuditDetailView;
};

/**
 * 任务 07 资料管理关键操作（R060/R061/R053 管理员作者删除；与实体 CHECK 同步）。
 *
 * 只有这三类写入本表：管理删除、归属更正、管理员以原作者身份删除。
 * 下架（R059）与普通修订（R058）只保留资料修订业务历史，不冒充关键操作。
 */
export type ManagementDocumentAuditOperation =
  'ADMIN_DELETE_DOCUMENT' | 'CORRECT_DOCUMENT_OWNERSHIP';

/**
 * 管理审计写入服务（S3 凭据类 + 任务07 资料类 + 任务10 三类业务事实）。
 *
 * 三个入口，职责不同，不可互相替代：
 * - `append()`：凭据补发/重置的成功事实，目标固定为账号，结果固定 SUCCEEDED；
 * - `appendDocumentEvent()`：任务 07 资料类事实（管理删除／归属更正），目标固定为
 *   资料，结果固定 SUCCEEDED（事务失败即整体回滚，不留成功假记录）；
 * - `appendBusinessOperation()`：R089 三类业务事实（资料删除、归属更正、本地恢复），
 *   目标通用，结果可为 SUCCEEDED／FAILED／DENIED。
 *
 * 共同约束：调用方必须处于写事务内，插入失败直接抛错并由事务整体回滚——审计失败
 * 不得返回成功；审计行一经写入即不可变；本服务不得写入三类业务操作与两类凭据
 * 操作以外的值。
 *
 * 敏感约束：`detail` 只允许脱敏摘要（重置原因、脱敏登录名、字段级变更摘要），
 * 绝不写入密码、哈希、派生值、Token、完整凭据或正文内容；日志也只记录操作类型
 * 与主键，不记录 detail。任务 10 读侧另有一套白名单投影（原因、阶段、变更字段、
 * 前后公司名等），写入方与读侧的键集合由各自契约独立约束。
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
        result: 'SUCCEEDED',
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
        result: 'SUCCEEDED',
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

  /**
   * 写入一条 R089 三类业务事实（供 07 资料删除／归属更正、09 本地恢复在各自事务内调用）。
   *
   * 契约由本方法强制，而不是靠调用方自觉：
   * - `operation` 只接受三类，凭据两类会被拒绝（必须先 `append()`）;
   * - `result` 可为 FAILED／DENIED，但不允许把预检、受理、排队写成 SUCCEEDED——
   *   这一点由调用方按"真实终态"传值，服务端只校验取值合法；
   * - `targetType`／`targetId` 只接受稳定标识（资料 ID、恢复运行 ID），不得写标题、
   *   正文或路径；`organizationId` 允许为 null（归属不明，仅一级管理员可见）；
   * - `detail` 与读侧共用白名单规则，非法键静默丢弃，全部非法时不写空 JSON。
   *
   * 参数违例抛 `MANAGEMENT_AUDIT_INVALID_WRITE_PARAMS`（服务端缺陷，非用户输入）。
   */
  async appendBusinessOperation(params: ManagementAuditBusinessOperationParams): Promise<void> {
    assertBusinessOperationParams(params);

    const repository = this.getRepository(params.transactionContext);
    const targetId = params.targetId.trim();

    await repository.insert({
      eventId: randomUUID(),
      actorAccountId: params.actorAccountId,
      actorAdminLevel: params.actorAdminLevel,
      organizationId: params.organizationId,
      operation: params.operation,
      targetType: params.targetType,
      targetId,
      result: params.result,
      detail: serializeManagementAuditDetail(params.detail),
    });

    this.logger.info(
      {
        operation: params.operation,
        organizationId: params.organizationId,
        targetType: params.targetType,
        targetId,
        result: params.result,
      },
      '关键操作记录已写入',
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
      result: string;
      detail: Record<string, unknown> | string | null;
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
      result: event.result,
      detail: toDetailColumn(event.detail),
    });
  }

  private getRepository(
    transactionContext: PersistenceTransactionContext,
  ): Repository<ManagementAuditEventEntity> {
    const manager = getTypeOrmEntityManager(transactionContext);
    return manager.getRepository(ManagementAuditEventEntity);
  }
}

/**
 * `detail` 列取值归一：对象按原样序列化（空对象写 null），已序列化的文本原样写入，
 * null 直接落 null。凭据类与资料类写入方传对象，任务 10 业务契约写入方传已按白名单
 * 序列化好的文本，两条路径共用同一列语义。
 */
function toDetailColumn(detail: Record<string, unknown> | string | null): string | null {
  if (detail === null) {
    return null;
  }
  if (typeof detail === 'string') {
    return detail;
  }
  return Object.keys(detail).length === 0 ? null : JSON.stringify(detail);
}

/**
 * 写入参数契约校验：失败关闭，把提供方的编程错误在插入前拦下。
 *
 * 与数据库 CHECK 的差别：DB 只保证「值属于集合」，这里额外保证「语义合法」——
 * 例如凭据类 operation 不得走本方法、target 不得为空串或控制字符。
 */
function assertBusinessOperationParams(params: ManagementAuditBusinessOperationParams): void {
  if (!Number.isInteger(params.actorAccountId) || params.actorAccountId <= 0) {
    throw new DomainError(
      MANAGEMENT_AUDIT_ERROR.INVALID_WRITE_PARAMS,
      '操作者账号 ID 必须是正整数',
    );
  }

  if (params.actorAdminLevel !== 1 && params.actorAdminLevel !== 2) {
    throw new DomainError(MANAGEMENT_AUDIT_ERROR.INVALID_WRITE_PARAMS, '操作者等级必须是 1 或 2');
  }

  if (
    params.organizationId !== null &&
    (!Number.isInteger(params.organizationId) || params.organizationId <= 0)
  ) {
    throw new DomainError(
      MANAGEMENT_AUDIT_ERROR.INVALID_WRITE_PARAMS,
      '公司 ID 必须是正整数或 null',
    );
  }

  if (!isManagementAuditQueryOperation(params.operation)) {
    throw new DomainError(
      MANAGEMENT_AUDIT_ERROR.INVALID_WRITE_PARAMS,
      '本方法只接受三类业务操作，凭据类请使用 append()',
    );
  }

  if (!TARGET_TYPE_PATTERN.test(params.targetType)) {
    throw new DomainError(
      MANAGEMENT_AUDIT_ERROR.INVALID_WRITE_PARAMS,
      '目标类型必须是大写下划线标识',
    );
  }

  const targetId = params.targetId.trim();
  if (
    targetId.length === 0 ||
    targetId.length > MAX_TARGET_ID_LENGTH ||
    hasControlCharacter(targetId)
  ) {
    throw new DomainError(
      MANAGEMENT_AUDIT_ERROR.INVALID_WRITE_PARAMS,
      '目标 ID 必须是 1–64 位且不含控制字符的稳定标识',
    );
  }

  if (!isManagementAuditResultValue(params.result)) {
    throw new DomainError(
      MANAGEMENT_AUDIT_ERROR.INVALID_WRITE_PARAMS,
      '结果值必须是 SUCCEEDED／FAILED／DENIED',
    );
  }
}
