import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, MANAGEMENT_AUDIT_ERROR } from '@core/common/errors/domain-error';
import {
  projectManagementAuditDetail,
  serializeManagementAuditDetail,
  type ManagementAuditDetailView,
} from '@core/management-audit/policy/management-audit-detail.policy';
import {
  serializeLocalRestoreAuditDetail,
  type LocalRestoreAuditStage,
} from '@core/local-runtime/policy/local-restore-audit.policy';
import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
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

/** 两类凭据管理操作（与 `chk_management_audit_operation` 同步）；不进入 GraphQL 枚举。 */
export type ManagementAuditCredentialOperation =
  'REISSUE_LEVEL2_CREDENTIAL' | 'RESET_LEVEL2_CREDENTIAL';

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
 * 本机业务恢复终态事件（任务 09）。
 */
export type LocalRestoreAuditOperation = 'RESTORE_LOCAL_BUSINESS';

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
  constructor(
    private readonly logger: PinoLogger,
    @Optional()
    @InjectRepository(ManagementAuditEventEntity)
    private readonly auditEventRepository?: Repository<ManagementAuditEventEntity>,
  ) {
    this.logger.setContext(ManagementAuditService.name);
  }

  async append(params: {
    readonly actorAccountId: number;
    readonly actorAdminLevel: number;
    readonly organizationId: number;
    readonly targetAccountId: number;
    readonly operation: ManagementAuditCredentialOperation;
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

  /**
   * 本机业务恢复终态事件（任务 09 S2-6／新计划第 06 项）。
   *
   * - 只在**终态**写入（成功／失败／回滚后失败），中途状态不写事件；
   * - detail 按**任务 10 的白名单契约**写入（`reason` 受控原因码 ＋ `stage` 阶段），
   *   恢复 ID／公司／操作者／结果走事件列，不塞进 detail；
   * - detail 只写脱敏摘要，**不写**包正文、凭据、堆栈、原件内容、文件路径或计数明细；
   * - **幂等**：同一 (恢复 ID, 终态) 只留一条事件 ⇒ 重试执行不产生重复记录；
   * - 写入失败**直接抛错**：终态事件写不进去时，恢复结果不得被当作"已完成"。
   */
  async appendRestoreEvent(params: {
    readonly actorAccountId: number;
    readonly actorAdminLevel: number;
    readonly organizationId: number;
    readonly operation: LocalRestoreAuditOperation;
    readonly restoreId: string;
    readonly backupId: string;
    readonly protectionBackupId: string | null;
    /** SUCCEEDED / FAILED */
    readonly result: 'SUCCEEDED' | 'FAILED';
    /** 恢复阶段（受任务 10 读侧 `stage` 字符集约束） */
    readonly stage: LocalRestoreAuditStage;
    /** 受控原因码 */
    readonly reasonCode?: string | null;
    /** 恢复计数摘要（行数；不含正文）——只进服务端日志，不进 detail */
    readonly counts?: { records: number; originals: number; queue: number };
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<void> {
    // 幂等：同一 (恢复 ID, 终态**结果**, 终态**阶段**) 只留一条事件
    // ⇒ 同一阶段的重复执行不产生重复记录；
    // ⇒ 但**阶段不同**是**另一个终态事实**（例如重试后从"已回滚"升级为"回滚也失败"，
    //    或从"已回滚"变成"冻结未解除"），必须各自留痕，不能被幂等吞掉。
    const repository = this.getRepository(params.transactionContext);
    const existing = await repository.findOne({
      where: {
        operation: params.operation,
        targetType: 'LOCAL_RESTORE',
        targetId: params.restoreId,
        result: params.result,
      },
    });
    if (existing !== null) {
      // 既有事件的阶段按**读侧同一套投影**取：读不出来的（历史自由文本）视为阶段未知
      const existingStage = projectManagementAuditDetail(existing.detail ?? null)?.stage;
      if (existingStage === params.stage) {
        return;
      }
    }
    const detail = serializeLocalRestoreAuditDetail({
      result: params.result,
      stage: params.stage,
      reasonCode: params.reasonCode ?? null,
    });
    await this.insertEvent(
      {
        actorAccountId: params.actorAccountId,
        actorAdminLevel: params.actorAdminLevel,
        organizationId: params.organizationId,
        operation: params.operation,
        targetType: 'LOCAL_RESTORE',
        targetId: params.restoreId,
        result: params.result,
        detail,
      },
      params.transactionContext,
    );
    this.logger.info(
      {
        operation: params.operation,
        restoreId: params.restoreId,
        result: params.result,
        stage: params.stage,
        counts: params.counts,
      },
      '本机业务恢复终态事件已写入',
    );
  }

  /**
   * 写**恢复故障现场处置**事件（管理员受控解冻）。
   *
   * 与 `appendRestoreEvent` 的差别：
   * - 幂等键是 **(恢复 ID, 阶段)**，不是 (恢复 ID, 结果, 阶段)——处置事件与恢复终态
   *   事件共用同一个 `result` 值域，若沿用恢复终态那套幂等键，处置事件会被恢复终态
   *   事件"挤掉"或与之互相吞掉；
   * - `result` 由调用方**镜像恢复自身的终态**（不是处置结果）⇒ 一次解冻**不会**让
   *   读侧把成功的恢复误读成失败（或反之）；处置事实由 `stage` 承载。
   */
  async appendRestoreIncidentEvent(params: {
    readonly actorAccountId: number;
    readonly actorAdminLevel: number;
    readonly organizationId: number;
    readonly restoreId: string;
    readonly backupId: string;
    readonly protectionBackupId: string | null;
    /** 镜像恢复自身的终态（SUCCEEDED / FAILED），**不是**处置结果 */
    readonly result: 'SUCCEEDED' | 'FAILED';
    readonly stage: LocalRestoreAuditStage;
    readonly reasonCode?: string | null;
    /**
     * **处置人的实际操作原因**（自由文本，已由上游做过去空白、长度边界与控制字符校验）。
     *
     * 只在"受控解冻成功"这一条处置事实上写入：那是管理员真正给出的处置理由，
     * 必须能从审计读回。与 `reasonCode` 同占 `detail.reason` 键（处置人原因优先）。
     */
    readonly operatorReason?: string | null;
    readonly transactionContext?: PersistenceTransactionContext;
  }): Promise<void> {
    const repository = this.getRepository(params.transactionContext);
    const existing: unknown = await repository
      .createQueryBuilder('event')
      .where('event.operation = :operation', { operation: 'RESTORE_LOCAL_BUSINESS' })
      .andWhere('event.target_type = :targetType', { targetType: 'LOCAL_RESTORE' })
      .andWhere('event.target_id = :targetId', { targetId: params.restoreId })
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(event.detail, '$.stage')) = :stage", {
        stage: params.stage,
      })
      .getRawAndEntities();
    if (existing !== null && Array.isArray(existing) && existing.length > 0) {
      // 幂等：同一 (恢复 ID, 阶段) 只留一条事件（重复处置不重复留痕）
      // ⇒ **首次真实处置人的原因不会被重试覆盖**。
      return;
    }
    const detail = serializeLocalRestoreAuditDetail({
      result: params.result,
      stage: params.stage,
      reasonCode: params.reasonCode ?? null,
      operatorReason: params.operatorReason ?? null,
    });
    await this.insertEvent(
      {
        actorAccountId: params.actorAccountId,
        actorAdminLevel: params.actorAdminLevel,
        organizationId: params.organizationId,
        operation: 'RESTORE_LOCAL_BUSINESS',
        targetType: 'LOCAL_RESTORE',
        targetId: params.restoreId,
        result: params.result,
        detail,
      },
      params.transactionContext,
    );
    this.logger.info(
      {
        operation: 'RESTORE_LOCAL_BUSINESS',
        restoreId: params.restoreId,
        result: params.result,
        stage: params.stage,
      },
      '恢复故障现场处置事件已写入',
    );
  }

  /**
   * 统计某次恢复已写入的**处置阶段**事件条数（幂等键的一侧）。
   *
   * 用途只有一个：故障处置在**提交回执丢失**时判定"事务到底提交了没有"
   * ——冻结已解除且成功事件已存在 ⇒ 事务其实已提交；两者都没有 ⇒ 已回滚。
   * 读侧（任务 10 的分页查询）另有 `ManagementAuditEventQueryService`，
   * 本方法**不是**通用查询入口。
   */
  async countRestoreIncidentEventsByStage(params: {
    readonly restoreId: string;
    readonly stage: LocalRestoreAuditStage;
  }): Promise<number> {
    const repository = this.getRepository();
    const existing: unknown = await repository
      .createQueryBuilder('event')
      .where('event.operation = :operation', { operation: 'RESTORE_LOCAL_BUSINESS' })
      .andWhere('event.target_type = :targetType', { targetType: 'LOCAL_RESTORE' })
      .andWhere('event.target_id = :targetId', { targetId: params.restoreId })
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(event.detail, '$.stage')) = :stage", {
        stage: params.stage,
      })
      .getRawAndEntities();
    if (!Array.isArray(existing)) {
      return 0;
    }
    return existing.length;
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
    transactionContext?: PersistenceTransactionContext,
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
    transactionContext?: PersistenceTransactionContext,
  ): Repository<ManagementAuditEventEntity> {
    if (transactionContext !== undefined) {
      const manager = getTypeOrmEntityManager(transactionContext);
      return manager.getRepository(ManagementAuditEventEntity);
    }
    if (this.auditEventRepository === undefined) {
      throw new Error('管理审计仓储不可用，无法写入审计事件');
    }
    return this.auditEventRepository;
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
