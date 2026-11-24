// src/modules/lithography/local-restore-incident-release.service.ts

/**
 * 恢复**故障现场**的受控解冻（管理员处置入口，任务 09 独立验收 P2-2）。
 *
 * ## 定位
 *
 * 既有 `LocalWriteHoldService.forceReleaseForRecoveryIncident()` 提供了"不错位地解冻"
 * 的原子动作（必须显式传入现场对应的恢复 ID），但**谁能解冻、什么条件下解冻、
 * 解冻后留下什么事实**此前没有任何产品／运维入口——独立验收报告把它列为 P1。
 *
 * 本服务是那条入口的**唯一裁决面**：
 * - 取事实（恢复运行、活动冻结、安装身份）全部**来自数据库复核**，不接受客户端传入；
 * - 裁决交给 core 纯策略 `decideRestoreIncidentReleaseVerdict()`，**默认失败关闭**；
 * - 解冻动作复用既有原子方法，不重复实现"怎么改状态"；
 * - 留下**操作者、原因、实际结果**的审计事件；事件里的 `result` **镜像恢复自身的终态**，
 *   阶段（stage）承载"处置事实"，因此**不会**把一次解冻伪装成一次恢复成功／失败。
 *
 * ## 原子性（任务 09 恢复链最小修复 02／03）
 *
 * **解冻与"成功处置审计"落在同一个数据库事务里**：
 * - 事务内先取**排他范围锁**（与建立／解除冻结同一把锁）⇒ 与在途业务写入互斥；
 * - 锁内**重新读取**恢复终态、安装公司与冻结归属（不依赖事务外的旧快照）；
 * - 同一事务内先解冻、再插入成功处置事件 ⇒ **任一步失败两者一起回滚**，
 *   不再存在"冻结已解除、成功审计未提交"的路径；
 * - 拒绝／无需解除路径不受影响：审计仍单独写入（不引入不必要的改造）。
 *
 * 锁顺序：命名锁（数据库会话锁，与建立／解除冻结同一把）→ 事务内排他范围锁 →
 * 恢复运行行锁 → 冻结行锁。既有恢复执行链在**各自独立的事务**里取这些锁
 * （认领事务只锁恢复行、不取范围锁；建立／解除冻结事务只取范围锁与冻结行），
 * 因此不存在"持范围锁再等运行行"与"持运行行再等范围锁"构成的死锁环。
 *
 * ## 处置原因（任务 09 恢复链最小修复 03）
 *
 * 管理员填写的处置原因**必须落库**（此前只判断"非空"，成功事件的原因恒为空）：
 * - 走**既有** `detail.reason` 白名单键（任务 10 读侧已能读出），不改已接受迁移、
 *   不新增 operation 类型；
 * - 写入前做最小校验：去首尾空白、长度上限 200 码点（与读侧展示上限一致）、
 *   拒绝控制字符 ⇒ 不合规则**明确拒绝**，不静默丢弃用户填写的内容；
 * - 原因**只进审计事件**，不进普通日志。
 *
 * ## 安全
 *
 * - 日志只带 `restoreId`／`organizationId`／受控原因码，**不含**密钥、正文、路径，
 *   **也不含**处置人填写的处置原因；
 * - 拒绝路径也留痕（阶段 `RESTORE_HOLD_FORCE_DENIED`），便于事后核对；
 * - 解冻**不改判**恢复终态，也不触碰恢复数据——它只解除"停写停传"。
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { PinoLogger } from 'nestjs-pino';
import { EntityManager, Repository } from 'typeorm';

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';

import { DomainError, SYNC_ERROR } from '@core/common/errors/domain-error';
import { LOCAL_RESTORE_AUDIT_STAGES } from '@core/local-runtime/policy/local-restore-audit.policy';
import {
  decideIncidentReleaseReasonVerdict,
  decideRestoreIncidentReleaseVerdict,
  LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES,
  LOCAL_RESTORE_INCIDENT_RELEASE_REASON_MAX_LENGTH,
  type LocalRestoreIncidentReleaseReasonCode,
  type RestoreIncidentReleaseStatus,
} from '@core/local-runtime/policy/local-restore-incident-release.policy';
import { LOCAL_WRITE_HOLD_TYPES } from '@core/local-runtime/policy/local-write-hold.policy';

import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';

import { BackupAssetEntity } from './entities/backup-asset.entity';
import { BackupRestoreRunEntity } from './entities/backup-restore-run.entity';
import { LocalInstallationEntity } from './entities/local-installation.entity';
import { LocalWriteHoldEntity } from './entities/local-write-hold.entity';

import { LocalWriteHoldService } from './local-write-hold.service';
import { LocalWriteScopeLockService } from './local-write-scope-lock.service';
import { ManagementAuditService } from './management-audit.service';

/** 处置结论 */
export type LocalRestoreIncidentReleaseOutcome = {
  readonly restoreId: string;
  /** RELEASED 已解除 / NOT_REQUIRED 无需解除 / DENIED 拒绝 */
  readonly outcome: 'RELEASED' | 'NOT_REQUIRED' | 'DENIED';
  /** 是否**确实**解除了冻结（NOT_REQUIRED 时为 false，不得谎报） */
  readonly released: boolean;
  /** 设备是否仍在停写停传 */
  readonly holdRetained: boolean;
  /** 受控原因码（拒绝时必有） */
  readonly reasonCode: LocalRestoreIncidentReleaseReasonCode | null;
  /** 受控原因说明（拒绝时必有；不含自由文本） */
  readonly reason: string | null;
  /** 恢复自身的终态（如实回报，不因解冻而改判） */
  readonly restoreStatus: RestoreIncidentReleaseStatus | null;
};

/** 事务内处置的结果分类 */
type ReleaseTransactionOutcome =
  | {
      readonly kind: 'RELEASED';
      readonly released: number;
      readonly run: BackupRestoreRunEntity | null;
    }
  | {
      readonly kind: 'NOT_REQUIRED';
      readonly run: BackupRestoreRunEntity | null;
    }
  | {
      readonly kind: 'REJECTED';
      readonly reasonCode: LocalRestoreIncidentReleaseReasonCode;
      readonly message: string;
      readonly run: BackupRestoreRunEntity | null;
      readonly holdCount: number;
    };

@Injectable()
export class LocalRestoreIncidentReleaseService {
  constructor(
    @InjectRepository(BackupRestoreRunEntity)
    private readonly restoreRunRepository: Repository<BackupRestoreRunEntity>,
    @InjectRepository(LocalWriteHoldEntity)
    private readonly holdRepository: Repository<LocalWriteHoldEntity>,
    @InjectRepository(BackupAssetEntity)
    private readonly backupAssetRepository: Repository<BackupAssetEntity>,
    @InjectRepository(LocalInstallationEntity)
    private readonly installationRepository: Repository<LocalInstallationEntity>,
    private readonly localWriteHoldService: LocalWriteHoldService,
    private readonly scopeLockService: LocalWriteScopeLockService,
    private readonly managementAuditService: ManagementAuditService,
    private readonly logger: PinoLogger,
  ) {}

  async release(input: {
    restoreId: string;
    actorAccountId: number;
    actorAdminLevel: number;
    /** 操作者被授权的公司数据区；null＝一级管理员的全局授权范围 */
    allowedOrganizationId: number | null;
    /** 是否为管理员（工程师／客户一律 false） */
    actorIsAdministrator: boolean;
    /** 处置原因（必填；只进审计事件，不进普通日志） */
    reason: string;
    /** 显式确认（必填） */
    confirmed: boolean;
    now?: Date;
  }): Promise<LocalRestoreIncidentReleaseOutcome> {
    const now = input.now ?? new Date();

    // 处置原因的最小校验（去首尾空白／长度上限／拒绝控制字符／拒绝敏感内容）：
    // 未填写交给裁决层判"必须填写"；**不合规的明确拒绝**，不静默丢弃用户填写的内容。
    //
    // 敏感内容（凭据／令牌、系统绝对路径）**拒绝输入**而不是"脱敏后放行"：
    // 脱敏会让审计里的原因不再是操作者真正写下的那句话（等于把原因伪装成不同事实），
    // 而错误提示只给"类型级"说明，**不回显命中内容**（不回显＝不回显到日志与响应）。
    // 拒绝发生在任何解冻动作之前 ⇒ **冻结保持原状态**。
    const reasonVerdict = decideIncidentReleaseReasonVerdict(input.reason);
    if (!reasonVerdict.ok && reasonVerdict.kind !== 'EMPTY') {
      throw new DomainError(SYNC_ERROR.INVALID_PARAMS, describeReasonRejection(reasonVerdict));
    }
    const reason = reasonVerdict.ok ? reasonVerdict.reason : '';

    const installation = await this.installationRepository.findOne({ where: { id: 1 } });

    // 取事实：**同一事务内**锁定读恢复运行与活动冻结
    // （行锁必须在显式事务里，TypeORM 才允许悲观锁）⇒ 判定基于一致的已提交事实。
    const snapshot = await this.restoreRunRepository.manager.transaction(async (manager) => {
      const run = await manager.getRepository(BackupRestoreRunEntity).findOne({
        where: { restoreId: input.restoreId },
        lock: { mode: 'pessimistic_write' },
      });
      const activeHolds =
        installation === null || run === null
          ? []
          : await manager.getRepository(LocalWriteHoldEntity).find({
              where: {
                installationId: installation.installationId,
                organizationId: run.organizationId,
                holdType: LOCAL_WRITE_HOLD_TYPES.RESTORE,
                status: 'ACTIVE',
              },
            });
      return { run, activeHolds };
    });
    const run = snapshot.run;
    const activeHolds = snapshot.activeHolds;

    // 本次处置**原本持有**的冻结条数（锁外预检口径）：锁内复核时用来区分
    // "自己的冻结被并发处置解除（⇒ 无需解除）"与"归属不符（⇒ 拒绝）"。
    const ownedHoldCountBeforeLock = activeHolds.filter(
      (row) => row.restoreId === input.restoreId,
    ).length;
    const verdict = await this.evaluateVerdict({
      actorIsAdministrator: input.actorIsAdministrator,
      allowedOrganizationId: input.allowedOrganizationId,
      confirmed: input.confirmed,
      restoreId: input.restoreId,
      reason,
      run,
      installation,
      activeHolds,
      findProtectionAsset: async (backupId) =>
        await this.backupAssetRepository.findOne({ where: { backupId } }),
    });

    if (!verdict.allowed) {
      return await this.reportRejected({
        actorAccountId: input.actorAccountId,
        actorAdminLevel: input.actorAdminLevel,
        restoreId: input.restoreId,
        reasonCode: verdict.reasonCode,
        message: verdict.message,
        run,
        holdCount: activeHolds.length,
      });
    }

    // ── 成功路径：一个事务内完成「锁内事实复核 → 解冻 → 成功处置审计」 ────────
    const installationId = installation?.installationId ?? '';
    const organizationId = run?.organizationId ?? 0;

    let outcome: ReleaseTransactionOutcome;
    try {
      outcome = await this.localWriteHoldService.withRecoveryScopeLock(
        { installationId, organizationId },
        async () =>
          await this.restoreRunRepository.manager.transaction(
            async (manager) =>
              await this.executeReleaseInTransaction({
                manager,
                input,
                reason,
                now,
                installationId,
                organizationId,
                ownedHoldCountBeforeLock,
              }),
          ),
      );
    } catch (error: unknown) {
      // 事务失败 ⇒ **整体回滚**（解冻与成功审计都没有生效）。
      // 但"提交回执丢失"这类**终局未知**必须如实区分：复读真实事实后再回报，
      // 不凭异常猜结果，也不谎报成功。
      return await this.reportFailedRelease({
        actorAccountId: input.actorAccountId,
        actorAdminLevel: input.actorAdminLevel,
        restoreId: input.restoreId,
        error,
        run,
        installationId,
        organizationId,
        restoreStatus: (run?.status as RestoreIncidentReleaseStatus | undefined) ?? null,
      });
    }

    if (outcome.kind === 'REJECTED') {
      return await this.reportRejected({
        actorAccountId: input.actorAccountId,
        actorAdminLevel: input.actorAdminLevel,
        restoreId: input.restoreId,
        reasonCode: outcome.reasonCode,
        message: outcome.message,
        run: outcome.run,
        holdCount: outcome.holdCount,
      });
    }
    if (outcome.kind === 'NOT_REQUIRED') {
      await this.appendIncidentEvent({
        run: outcome.run,
        actorAccountId: input.actorAccountId,
        actorAdminLevel: input.actorAdminLevel,
        stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_NOT_REQUIRED,
        reasonCode: LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.NO_ACTIVE_HOLD,
      });
      return {
        restoreId: input.restoreId,
        outcome: 'NOT_REQUIRED',
        released: false,
        holdRetained: false,
        reasonCode: LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.NO_ACTIVE_HOLD,
        reason: '当前没有活动冻结，无需解除',
        restoreStatus: (outcome.run?.status as RestoreIncidentReleaseStatus | undefined) ?? null,
      };
    }

    this.logger.warn(
      {
        restoreId: input.restoreId,
        organizationId: outcome.run?.organizationId ?? organizationId,
        actorAccountId: input.actorAccountId,
      },
      '恢复故障现场的冻结已由管理员受控解除（恢复终态未改判）',
    );
    // 设备是否仍在停写停传：按**剩余**活动冻结如实回报
    // （别的恢复留下的冻结仍在 ⇒ 设备仍停写停传，不得说"完全恢复了写入"）
    const remaining = await this.countActiveHolds(installationId, organizationId);
    return {
      restoreId: input.restoreId,
      outcome: 'RELEASED',
      released: true,
      holdRetained: remaining > 0,
      reasonCode: null,
      reason: null,
      restoreStatus: (outcome.run?.status as RestoreIncidentReleaseStatus | undefined) ?? null,
    };
  }

  /**
   * 拒绝／无需解除路径：留痕并如实回报（**不解冻**）。
   *
   * "没有活动冻结"不是**拒绝**，而是**无需解除**（幂等）：
   * 两者都必须如实回报，不得把"无事可做"说成"被拒绝"，也不得说成"又解冻了一次"。
   */
  /**
   * 成功路径的**事务内**动作：排他范围锁 → 锁内事实复核 → 解冻 → 成功处置审计。
   *
   * 四步在**同一个事务**里：任一步失败 ⇒ 整体回滚（解冻与成功审计同生共死）。
   */
  private async executeReleaseInTransaction(params: {
    manager: EntityManager;
    input: {
      restoreId: string;
      actorAccountId: number;
      actorAdminLevel: number;
      actorIsAdministrator: boolean;
      allowedOrganizationId: number | null;
      confirmed: boolean;
    };
    reason: string;
    now: Date;
    installationId: string;
    organizationId: number;
    ownedHoldCountBeforeLock: number;
  }): Promise<ReleaseTransactionOutcome> {
    const { manager, input, reason, now, installationId, organizationId } = params;
    // ① **排他范围锁**（与建立／解除冻结同一把锁）：与在途业务写入串行
    await this.scopeLockService.acquireExclusiveScopeLock({
      manager,
      installationId,
      organizationId,
    });
    // ② 锁内**重新读取**事实（不依赖事务外的旧快照）
    const fresh = await this.readFactsInTransaction(manager, input.restoreId);
    const freshVerdict = await this.evaluateVerdict({
      actorIsAdministrator: input.actorIsAdministrator,
      allowedOrganizationId: input.allowedOrganizationId,
      confirmed: input.confirmed,
      restoreId: input.restoreId,
      reason,
      run: fresh.run,
      installation: fresh.installation,
      activeHolds: fresh.activeHolds,
      previouslyOwnedHoldCount: params.ownedHoldCountBeforeLock,
      findProtectionAsset: async (backupId) =>
        await manager.getRepository(BackupAssetEntity).findOne({ where: { backupId } }),
    });
    if (!freshVerdict.allowed) {
      // 锁内复核发现前提已变（并发处置／事实变化）⇒ 本次不解冻，如实回报
      return {
        kind: 'REJECTED',
        reasonCode: freshVerdict.reasonCode,
        message: freshVerdict.message,
        run: fresh.run,
        holdCount: fresh.activeHolds.length,
      } satisfies ReleaseTransactionOutcome;
    }
    // ③ 解冻（**同一事务**；归属不符由服务内部再次校验）
    const released = await this.localWriteHoldService.releaseForRecoveryIncidentInTransaction({
      manager,
      installationId,
      organizationId,
      holdType: LOCAL_WRITE_HOLD_TYPES.RESTORE,
      incidentRestoreId: input.restoreId,
      now,
    });
    if (released <= 0) {
      // 并发下可能已被别的处置解掉：如实回报"无需解除"，不谎报
      return {
        kind: 'NOT_REQUIRED',
        run: fresh.run,
      } satisfies ReleaseTransactionOutcome;
    }
    // ④ 成功处置审计（**同一事务**）：与解冻同生共死
    try {
      await this.appendIncidentEvent({
        run: fresh.run,
        actorAccountId: input.actorAccountId,
        actorAdminLevel: input.actorAdminLevel,
        stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_RELEASED,
        reasonCode: null,
        operatorReason: reason,
        transactionContext: createTypeOrmPersistenceTransactionContext(manager),
      });
    } catch (error: unknown) {
      // 审计写不进去 ⇒ 抛出受控错误 ⇒ **整个事务回滚**（解冻也不生效）
      throw new DomainError(
        SYNC_ERROR.INVALID_PARAMS,
        '处置审计写入失败，本次处置已整体回滚（冻结保留）',
        {
          reasonCode: LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.AUDIT_FAILED,
        },
        error,
      );
    }
    return {
      kind: 'RELEASED',
      released,
      run: fresh.run,
    } satisfies ReleaseTransactionOutcome;
  }
  private async reportRejected(params: {
    actorAccountId: number;
    actorAdminLevel: number;
    restoreId: string;
    reasonCode: LocalRestoreIncidentReleaseReasonCode;
    message: string;
    run: BackupRestoreRunEntity | null;
    holdCount: number;
  }): Promise<LocalRestoreIncidentReleaseOutcome> {
    const restoreStatus = (params.run?.status as RestoreIncidentReleaseStatus | undefined) ?? null;
    if (params.reasonCode === LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.NO_ACTIVE_HOLD) {
      await this.appendIncidentEvent({
        run: params.run,
        actorAccountId: params.actorAccountId,
        actorAdminLevel: params.actorAdminLevel,
        stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_NOT_REQUIRED,
        reasonCode: params.reasonCode,
      });
      return {
        restoreId: params.restoreId,
        outcome: 'NOT_REQUIRED',
        released: false,
        holdRetained: false,
        reasonCode: params.reasonCode,
        reason: params.message,
        restoreStatus,
      };
    }
    await this.appendIncidentEvent({
      run: params.run,
      actorAccountId: params.actorAccountId,
      actorAdminLevel: params.actorAdminLevel,
      stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_DENIED,
      reasonCode: params.reasonCode,
    });
    this.logger.warn(
      {
        restoreId: params.restoreId,
        reasonCode: params.reasonCode,
        organizationId: params.run?.organizationId ?? null,
      },
      '恢复故障现场处置被拒绝（未解除任何冻结）',
    );
    return {
      restoreId: params.restoreId,
      outcome: 'DENIED',
      released: false,
      holdRetained: params.holdCount > 0,
      reasonCode: params.reasonCode,
      reason: params.message,
      restoreStatus,
    };
  }

  /**
   * 处置失败（事务回滚）：冻结保留，并如实区分失败原因。
   *
   * 终局未知时（提交回执丢失）复读真实事实：
   * - 冻结已解除**且**成功审计已存在 ⇒ 事务其实已提交 ⇒ 如实回报"已解除"；
   * - 冻结已不在（被并发处置解掉）⇒ "无需解除"；
   * - 冻结仍 ACTIVE ⇒ 处置失败，冻结保留（设备继续停写停传）。
   */
  private async reportFailedRelease(params: {
    actorAccountId: number;
    actorAdminLevel: number;
    restoreId: string;
    error: unknown;
    run: BackupRestoreRunEntity | null;
    installationId: string;
    organizationId: number;
    restoreStatus: RestoreIncidentReleaseStatus | null;
  }): Promise<LocalRestoreIncidentReleaseOutcome> {
    const auditFailed = isAuditFailedError(params.error);
    const ownedActive = await this.countActiveHolds(
      params.installationId,
      params.organizationId,
      params.restoreId,
    );
    if (ownedActive === 0) {
      const releasedAuditCount =
        await this.managementAuditService.countRestoreIncidentEventsByStage({
          restoreId: params.restoreId,
          stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_RELEASED,
        });
      if (releasedAuditCount > 0) {
        // 事务其实已提交（解冻与成功审计同在）⇒ 如实回报"已解除"，不得谎报失败
        this.logger.warn(
          {
            restoreId: params.restoreId,
            organizationId: params.organizationId,
            actorAccountId: params.actorAccountId,
          },
          '恢复故障现场的处置提交回执丢失，但复读事实确认已提交（冻结已解除且成功审计已写入）',
        );
        return {
          restoreId: params.restoreId,
          outcome: 'RELEASED',
          released: true,
          holdRetained:
            (await this.countActiveHolds(params.installationId, params.organizationId)) > 0,
          reasonCode: null,
          reason: null,
          restoreStatus: params.restoreStatus,
        };
      }
      // 并发下可能已被别的处置解掉：如实回报"无需解除"
      await this.appendIncidentEvent({
        run: params.run,
        actorAccountId: params.actorAccountId,
        actorAdminLevel: params.actorAdminLevel,
        stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_NOT_REQUIRED,
        reasonCode: LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.NO_ACTIVE_HOLD,
      });
      return {
        restoreId: params.restoreId,
        outcome: 'NOT_REQUIRED',
        released: false,
        holdRetained: false,
        reasonCode: LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.NO_ACTIVE_HOLD,
        reason: '当前没有活动冻结，无需解除',
        restoreStatus: params.restoreStatus,
      };
    }
    const reasonCode = auditFailed
      ? LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.AUDIT_FAILED
      : LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.RELEASE_FAILED;
    await this.appendIncidentEvent({
      run: params.run,
      actorAccountId: params.actorAccountId,
      actorAdminLevel: params.actorAdminLevel,
      stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_FAILED,
      reasonCode,
    });
    this.logger.error(
      { err: params.error, restoreId: params.restoreId },
      '恢复故障现场的处置失败（整体回滚，冻结保留，设备继续停写停传）',
    );
    return {
      restoreId: params.restoreId,
      outcome: 'DENIED',
      released: false,
      holdRetained: true,
      reasonCode,
      reason: auditFailed ? '处置留痕失败，本次处置已整体回滚，冻结保留' : '冻结解除失败，冻结保留',
      restoreStatus: params.restoreStatus,
    };
  }

  /**
   * 数据一致性是否可确认。
   *
   * 只认**持久化的终态事实**（`result_summary`）：
   * - 成功 ⇒ 数据已是恢复后状态；
   * - 失败且 `rolledBack` ⇒ 数据已回到恢复前状态；
   * - 失败但 `holdRetained`（回滚失败）／中断／未知 ⇒ **不可确认** ⇒ 拒绝解冻。
   */
  private isDataConsistencyConfirmed(run: BackupRestoreRunEntity | null): boolean {
    if (run === null) {
      return false;
    }
    if (run.status === 'SUCCEEDED') {
      return true;
    }
    if (run.status !== 'FAILED') {
      return false;
    }
    return this.readResultSummary(run)['rolledBack'] === true;
  }

  /**
   * 保护副本是否可确认。
   *
   * - 恢复已成功 ⇒ 数据不再依赖保护副本；
   * - 已按保护副本回滚 ⇒ 回滚依据成立；
   * - 其余（回滚失败／中断）⇒ 保护副本**必须仍在**（人工修复数据要靠它），
   *   因此这里读**真实资产行**判断（不存在或已清理 ⇒ 不可确认）。
   */
  private async isProtectionCopyConfirmed(
    run: BackupRestoreRunEntity | null,
    dataConsistencyConfirmed: boolean,
    findAsset: (backupId: string) => Promise<BackupAssetEntity | null>,
  ): Promise<boolean> {
    if (run === null) {
      return false;
    }
    if (run.status === 'SUCCEEDED') {
      return true;
    }
    if (dataConsistencyConfirmed) {
      return true;
    }
    if (run.protectionBackupId === null) {
      return false;
    }
    const asset = await findAsset(run.protectionBackupId);
    return asset !== null && asset.localStatus !== 'CLEANED';
  }

  private readResultSummary(run: BackupRestoreRunEntity): Readonly<Record<string, unknown>> {
    const raw = run.resultSummary;
    if (raw === null || raw === undefined || raw.trim().length === 0) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {};
      }
      return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /**
   * 裁决"能否强制解除这次恢复留下的冻结"（事实全部来自数据库复核）。
   *
   * 事务内复核与事务外预检**共用同一套口径** ⇒ 两处判定不会漂移。
   */
  private async evaluateVerdict(params: {
    actorIsAdministrator: boolean;
    allowedOrganizationId: number | null;
    confirmed: boolean;
    restoreId: string;
    reason: string;
    run: BackupRestoreRunEntity | null;
    installation: LocalInstallationEntity | null;
    activeHolds: LocalWriteHoldEntity[];
    /** 本次处置**原本持有**的冻结条数（并发解除时用来判"无需解除"而非"归属不符"） */
    previouslyOwnedHoldCount?: number;
    findProtectionAsset: (backupId: string) => Promise<BackupAssetEntity | null>;
  }) {
    const run = params.run;
    // 本次处置**可以解除**的冻结：归属于本次恢复 ID 的那些；
    // 其余是**别人的**冻结——既不解除，也不因此说"冻结已解除"。
    const ownedHolds = params.activeHolds.filter((row) => row.restoreId === params.restoreId);
    const otherHolds = params.activeHolds.filter((row) => row.restoreId !== params.restoreId);

    const dataConsistencyConfirmed = this.isDataConsistencyConfirmed(run);
    const protectionCopyConfirmed = await this.isProtectionCopyConfirmed(
      run,
      dataConsistencyConfirmed,
      params.findProtectionAsset,
    );

    return decideRestoreIncidentReleaseVerdict({
      actorIsAdministrator: params.actorIsAdministrator,
      allowedOrganizationId: params.allowedOrganizationId,
      restoreExists: run !== null,
      installationMatches:
        run !== null &&
        params.installation !== null &&
        run.targetInstallationId === params.installation.installationId,
      restoreOrganizationId: run?.organizationId ?? null,
      restoreStatus: (run?.status as RestoreIncidentReleaseStatus | undefined) ?? null,
      dataConsistencyConfirmed,
      protectionCopyConfirmed,
      ownedHoldCount: ownedHolds.length,
      otherHoldCount: otherHolds.length,
      previouslyOwnedHoldCount: params.previouslyOwnedHoldCount ?? 0,
      reasonProvided: params.reason.length > 0,
      confirmed: params.confirmed,
    });
  }

  /** 事务内读取事实（锁定读）：恢复运行、安装身份、活动冻结 */
  private async readFactsInTransaction(
    manager: EntityManager,
    restoreId: string,
  ): Promise<{
    run: BackupRestoreRunEntity | null;
    installation: LocalInstallationEntity | null;
    activeHolds: LocalWriteHoldEntity[];
  }> {
    const run = await manager.getRepository(BackupRestoreRunEntity).findOne({
      where: { restoreId },
      lock: { mode: 'pessimistic_write' },
    });
    const installation = await manager
      .getRepository(LocalInstallationEntity)
      .findOne({ where: { id: 1 } });
    const activeHolds =
      installation === null || run === null
        ? []
        : await manager.getRepository(LocalWriteHoldEntity).find({
            where: {
              installationId: installation.installationId,
              organizationId: run.organizationId,
              holdType: LOCAL_WRITE_HOLD_TYPES.RESTORE,
              status: 'ACTIVE',
            },
            lock: { mode: 'pessimistic_write' },
          });
    return { run, installation, activeHolds };
  }

  /**
   * 该公司数据区当前的 RESTORE 类型活动冻结条数。
   *
   * @param restoreId 只统计归属于该恢复的冻结；`null` 表示统计全部（用于回报"设备是否仍在停写停传"）。
   */
  private async countActiveHolds(
    installationId: string,
    organizationId: number,
    restoreId: string | null = null,
  ): Promise<number> {
    if (installationId === '' || organizationId === 0) {
      return 0;
    }
    return await this.holdRepository.count({
      where: {
        installationId,
        organizationId,
        holdType: LOCAL_WRITE_HOLD_TYPES.RESTORE,
        status: 'ACTIVE',
        ...(restoreId === null ? {} : { restoreId }),
      },
    });
  }

  /**
   * 写处置审计事件。
   *
   * `result` **镜像恢复自身的终态**（不是处置结果）⇒ 一次解冻**不会**让读侧把
   * 一次成功的恢复误读成失败（或反之）；处置事实由 `stage` 承载。
   */
  private async appendIncidentEvent(input: {
    run: BackupRestoreRunEntity | null;
    actorAccountId: number;
    actorAdminLevel: number;
    stage: (typeof LOCAL_RESTORE_AUDIT_STAGES)[keyof typeof LOCAL_RESTORE_AUDIT_STAGES];
    reasonCode: string | null;
    /** 处置人的实际操作原因（只写成功处置事件；不写普通日志） */
    operatorReason?: string | null;
    /** 事务上下文：与解冻同事务时传入（成功事件必须同事务） */
    transactionContext?: PersistenceTransactionContext;
  }): Promise<void> {
    if (input.run === null) {
      // 恢复运行不存在 ⇒ 没有可挂载的恢复事实，只进服务端日志（不写事件）
      return;
    }
    await this.managementAuditService.appendRestoreIncidentEvent({
      actorAccountId: input.actorAccountId,
      actorAdminLevel: input.actorAdminLevel,
      organizationId: input.run.organizationId,
      restoreId: input.run.restoreId,
      backupId: input.run.backupId,
      protectionBackupId: input.run.protectionBackupId ?? null,
      result: input.run.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
      stage: input.stage,
      reasonCode: input.reasonCode,
      operatorReason: input.operatorReason ?? null,
      ...(input.transactionContext === undefined
        ? {}
        : { transactionContext: input.transactionContext }),
    });
  }
}

/** 是否为"成功处置审计写入失败"（⇒ 事务整体回滚，冻结保留） */
function isAuditFailedError(error: unknown): boolean {
  if (!(error instanceof DomainError)) {
    return false;
  }
  const details = error.details as { reasonCode?: unknown } | undefined;
  return details?.reasonCode === LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.AUDIT_FAILED;
}

/**
 * 处置原因被拒绝时的提示文案。
 *
 * 只给"类型级"说明，**绝不回显命中的原文**（原文可能是凭据／系统路径）：
 * 提示会进入 GraphQL 错误响应与服务端日志，回显等于二次泄漏。
 */
function describeReasonRejection(verdict: {
  readonly kind: string;
  readonly sensitiveKind?: string;
}): string {
  if (verdict.kind === 'TOO_LONG') {
    return `处置原因过长（最多 ${LOCAL_RESTORE_INCIDENT_RELEASE_REASON_MAX_LENGTH} 字）`;
  }
  if (verdict.kind === 'CONTROL_CHARACTER') {
    return '处置原因不得包含控制字符';
  }
  if (verdict.kind === 'SENSITIVE_CONTENT') {
    return verdict.sensitiveKind === 'ABSOLUTE_PATH'
      ? '处置原因不得包含系统绝对路径'
      : '处置原因不得包含凭据、令牌或口令';
  }
  return '处置原因不合规';
}
