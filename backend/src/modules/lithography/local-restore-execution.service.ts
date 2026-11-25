// src/modules/lithography/local-restore-execution.service.ts

/**
 * 恢复执行编排（任务 09 S5-2／S5-3）。
 *
 * 链路（顺序固定，**失败关闭**）：
 *   受理事实 → 写传冻结 → 按清单恢复（业务数据／原件／队列）→ 核验 → 解除冻结
 *
 * 关键语义：
 * - **冻结先于任何写入**：恢复期间目标公司数据区停写停传（写传冻结闸门）；
 * - **失败保持冻结**：恢复中途失败**不**解除冻结、**不**删除保护副本与任务
 *   ⇒ 设备继续停写停传，且冻结事实落库 ⇒ **重启后仍可识别**（S5-3）；
 * - **业务数据写入走中立受控端口**：未注册即失败关闭
 *   （恢复编排**不**直接写业务表，与记录包导入同一条纪律）；
 * - **受理 ≠ 恢复成功**：终态如实写回恢复运行（状态 ＋ 原因 ＋ 范围）。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Inject, Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { PinoLogger } from 'nestjs-pino';
import { Repository } from 'typeorm';

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';

import {
  BACKUP_PAYLOAD_PATH,
  decryptBackupPayload,
  parseBackupManifest,
  parseProtectionKey,
} from '@core/local-runtime/policy/protected-backup.policy';
import {
  LOCAL_BACKUP_FAILURE_REASON,
  LOCAL_RESTORE_EXECUTION_REASON_CODES,
} from '@core/local-runtime/policy/local-backup-failure-reason';
import { resolveRestoreExecutionCapability } from '@core/local-runtime/policy/restore-execution-capability.policy';
import {
  LOCAL_RESTORE_AUDIT_STAGES,
  type LocalRestoreAuditStage,
} from '@core/local-runtime/policy/local-restore-audit.policy';
import type { LocalRuntimeAdminLevel } from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';

import { ManagementAuditService } from './management-audit.service';
import { BackupAssetEntity } from './entities/backup-asset.entity';
import { BackupRestoreRunEntity } from './entities/backup-restore-run.entity';
import { LocalInstallationEntity } from './entities/local-installation.entity';
import { LocalBackupCleanupService } from './local-backup-cleanup.service';
import { LocalWriteHoldService } from './local-write-hold.service';

import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';

import {
  LOCAL_BACKUP_PROTECTION,
  type ProtectedBackupMaterial,
} from '@usecases/common/ports/protected-backup.contract';
import {
  LOCAL_RESTORE_RECORD_WRITER,
  type LocalRestoreRecordTable,
  type LocalRestoreRecordWriter,
} from '@usecases/common/ports/local-restore-record-writer.contract';

/**
 * 恢复执行的**受控失败说明**（对外可见的说明文案）。
 *
 * 口径（与 `local-backup-failure-reason.ts` 同一纪律）：
 * 原始异常（Node fs 异常含**本机绝对路径**、数据库异常含约束名／SQL 片段）
 * **只进服务端日志**，不进任何对外字段——此前本文件把 `error.message`
 * 直接塞进 `reason`，并经 GraphQL `reason` 字段下发到浏览器，
 * 等于把本机目录布局与库表结构泄露到前端。
 */
const RESTORE_FAILURE_REASON_TEXT = {
  /** 恢复范围被其它恢复占用 */
  SCOPE_OCCUPIED: '恢复范围已被其它恢复占用',
  /** 恢复执行过程中出现未归类异常（原始异常只进服务端日志） */
  EXECUTION_FAILED: '恢复执行失败（详细原因见服务端日志）',
  /** 核验失败：写回后的业务数据行数与备份清单不一致 */
  VERIFY_FAILED: '恢复核验失败：写回后的业务数据行数与备份清单不一致',
} as const;

/** 恢复执行结论 */
export type LocalRestoreExecutionOutcome =
  | {
      status: 'SUCCEEDED';
      restoreId: string;
      /** 逐项恢复计数 */
      restored: { records: number; originals: number; queue: number };
      /** 冻结是否已解除 */
      released: boolean;
      /**
       * 设备是否**仍在停写停传**。
       *
       * 成功终态下也可能为 true：终态已发布（数据确实恢复成功）但**冻结解除失败**
       * ⇒ 保守保留停写停传，等人工处置（任务 09 独立验收 P1-3）。
       */
      holdRetained: boolean;
    }
  | {
      status: 'FAILED';
      restoreId: string;
      /** 受控原因码 */
      reasonCode: string;
      reason: string;
      /** 冻结是否**保持**（失败时为 true：设备继续停写停传） */
      holdRetained: boolean;
    };

@Injectable()
export class LocalRestoreExecutionService {
  constructor(
    @InjectRepository(BackupRestoreRunEntity)
    private readonly restoreRunRepository: Repository<BackupRestoreRunEntity>,
    @InjectRepository(BackupAssetEntity)
    private readonly backupAssetRepository: Repository<BackupAssetEntity>,
    @InjectRepository(LocalInstallationEntity)
    private readonly installationRepository: Repository<LocalInstallationEntity>,
    private readonly localWriteHoldService: LocalWriteHoldService,
    private readonly managementAuditService: ManagementAuditService,
    private readonly moduleRef: ModuleRef,
    private readonly logger: PinoLogger,
    @Optional()
    @Inject(LOCAL_BACKUP_PROTECTION)
    private readonly backupProtection?: ProtectedBackupMaterial,
    @Optional()
    private readonly backupCleanupService?: LocalBackupCleanupService,
  ) {}

  /**
   * 执行一次恢复。
   *
   * @param input.restoreId 恢复运行 ID（受理后）
   * @param input.actorAccountId 实际执行人（写入恢复事实）
   * @param input.actorAdminLevel 实际执行人的**管理员等级**（请求期数据库复核结果）：
   *        恢复终态审计事件里的 `actor_admin_level` 必须是它，
   *        不接受客户端自报，也不缺省成一级。
   * @param input.allowedOrganizationId 执行人的公司授权范围（null＝一级管理员全局范围）
   */
  async execute(input: {
    restoreId: string;
    actorAccountId: number;
    actorAdminLevel: LocalRuntimeAdminLevel;
    allowedOrganizationId?: number | null;
    now?: Date;
  }): Promise<LocalRestoreExecutionOutcome> {
    const now = input.now ?? new Date();
    // ───────────────────────────────────────────────────────────────
    // ⓪ 锁前**快路径**核对：只为少占一次执行权，**不是权威判定**。
    //    这里的读**可能已过期**（另一个执行者可能刚刚跑完），
    //    权威判定在取得执行权之后（见 ⓪′）。
    // ───────────────────────────────────────────────────────────────
    const run = await this.restoreRunRepository.findOne({
      where: { restoreId: input.restoreId },
    });
    if (run === null) {
      return this.failed(
        input.restoreId,
        LOCAL_RESTORE_EXECUTION_REASON_CODES.RUN_NOT_FOUND,
        '恢复运行不存在',
        false,
      );
    }
    if (run.status !== 'RUNNING') {
      return this.failed(
        input.restoreId,
        LOCAL_RESTORE_EXECUTION_REASON_CODES.NOT_ACCEPTED,
        '恢复未被受理或已结束，不能重复执行',
        false,
      );
    }
    if (run.checkStatus !== 'PASSED') {
      return this.failed(
        input.restoreId,
        LOCAL_RESTORE_EXECUTION_REASON_CODES.CHECK_NOT_PASSED,
        '恢复预检未通过',
        false,
      );
    }
    if (run.confirmation === null || run.confirmation === undefined) {
      return this.failed(
        input.restoreId,
        LOCAL_RESTORE_EXECUTION_REASON_CODES.NOT_ACCEPTED,
        '恢复未受理',
        false,
      );
    }

    const installation = await this.installationRepository.findOne({ where: { id: 1 } });
    if (installation === null) {
      return this.failed(
        input.restoreId,
        LOCAL_RESTORE_EXECUTION_REASON_CODES.INSTALLATION_MISSING,
        '本机安装身份未初始化',
        false,
      );
    }

    // 快路径只需要**保护副本**（回滚补偿闸门）；被恢复的包在取得执行权之后按最新事实取
    const protection = await this.backupAssetRepository.findOne({
      where: { backupId: run.protectionBackupId ?? '' },
    });
    const protectionReady =
      protection !== null && protection.localStatus !== 'CLEANED' && !!protection.localReference;

    // 三道闸门（core 策略裁决）：缺任一闸门即如实不可用。
    // 口径说明（review 遗留 L1）：这里判的是**本次恢复级**事实，
    // 与能力查询（`LocalRestoreExecutionCapabilityProbe`）的**环境级**事实是两个维度：
    // - 写/同步闸门：本次恢复能否冻结目标公司数据区（前提是安装身份已初始化）
    // - 失败回滚补偿：本次恢复的保护副本是否就绪（资产级事实）
    // - 受保护包解密材料：环境级事实
    const capability = resolveRestoreExecutionCapability({
      writeGateReady: installation !== null,
      failureCompensationReady: protectionReady,
      protectionKeyReady: this.readProtectionKey() !== null,
    });
    if (!capability.executionAvailable) {
      return this.failed(
        input.restoreId,
        capability.reasonCode,
        `恢复执行闸门未就绪：${capability.missingGates.join(',')}`,
        false,
      );
    }

    // ⓪ 执行权（数据库级互斥，G30–G33）：同一次恢复**不得并发执行**。
    //    浏览器重复点击、Worker 重投都会并发打到这里 ⇒ 必须由数据库裁决，
    //    不能靠"先查后写"。进程崩溃时锁由数据库自动释放 ⇒ 中断后仍可重新执行收口。
    const executionLock = await this.tryAcquireExecutionLock(run.restoreId);
    if (executionLock === null) {
      // 本次恢复**一个字都没写** ⇒ 不走回滚路径（没有可回滚的东西），
      // 也不改恢复运行行（另一个执行者还在用它）⇒ 只如实受控拒绝。
      return this.failed(
        input.restoreId,
        LOCAL_RESTORE_EXECUTION_REASON_CODES.EXECUTION_ALREADY_RUNNING,
        '该恢复正在执行中，不接受并发执行',
        true,
      );
    }

    // 执行期事实一律以**取得执行权之后的最新事实**为准（下面 ⓪′ 覆盖这三个变量）
    let activeRun: BackupRestoreRunEntity = run;
    let activeProtection: BackupAssetEntity | null = protection;

    try {
      // ⓪′ **重新读取／锁定最新运行事实 ＋ 原子占用**（任务 09 独立验收 P1-2）
      //
      // 为什么必须在取得执行权**之后**做：
      // - 锁前的读可能已过期：A 读到 RUNNING → A 跑完并释放执行权 →
      //   B 此时取得执行权，若继续用**旧对象**，就会把**已终态**的恢复**再执行一遍**
      //   （把旧备份再写一遍、覆盖 A 的结果）；
      // - 权威判定必须在**执行权已独占**的前提下做，否则"读到 RUNNING"与"开始写入"之间
      //   仍有窗口。
      //
      // 这里做三件事：
      // ① 锁定读（当前读）取**最新已提交**的运行事实，并对该行加排他锁；
      // ② 重新校验状态／预检／确认／保护副本／公司／安装；
      // ③ 条件更新（CAS）**原子占用**：只有仍处于"已受理执行中"的行才能被占用。
      const claim = await this.claimRestoreExecution({
        restoreId: input.restoreId,
        actorAccountId: input.actorAccountId,
        actorAdminLevel: input.actorAdminLevel,
        installationId: installation.installationId,
        allowedOrganizationId: input.allowedOrganizationId ?? null,
        now,
      });
      if (!claim.ok) {
        // 受控拒绝：**一个字都没写**（未建立冻结、未恢复业务数据、未写终态事件）
        const frozen = await this.isCompanyFrozen(
          installation.installationId,
          claim.organizationId,
        );
        this.logger.warn(
          { restoreId: input.restoreId, reasonCode: claim.reasonCode },
          '恢复执行占用未取得（最新运行事实不满足执行条件），本次恢复受控拒绝',
        );
        return this.failed(input.restoreId, claim.reasonCode, claim.reason, frozen);
      }
      activeRun = claim.run;

      // 资产按**最新事实**重新取（旧对象不得继续使用）
      const activeSource = await this.backupAssetRepository.findOne({
        where: { backupId: activeRun.backupId },
      });
      activeProtection = await this.backupAssetRepository.findOne({
        where: { backupId: activeRun.protectionBackupId ?? '' },
      });
      const activeProtectionReady =
        activeProtection !== null &&
        activeProtection.localStatus !== 'CLEANED' &&
        !!activeProtection.localReference;
      // 闸门按最新事实重判一次（保护副本可能在受理之后被清理）
      const activeCapability = resolveRestoreExecutionCapability({
        writeGateReady: true,
        failureCompensationReady: activeProtectionReady,
        protectionKeyReady: this.readProtectionKey() !== null,
      });
      if (!activeCapability.executionAvailable) {
        return this.failed(
          input.restoreId,
          activeCapability.reasonCode,
          `恢复执行闸门未就绪：${activeCapability.missingGates.join(',')}`,
          await this.isCompanyFrozen(installation.installationId, activeRun.organizationId),
        );
      }

      // ① 冻结（先于任何写入）：恢复期间目标公司数据区停写停传
      try {
        await this.localWriteHoldService.hold({
          installationId: installation.installationId,
          organizationId: activeRun.organizationId,
          restoreId: activeRun.restoreId,
          reason: `恢复执行中（${activeRun.restoreId}）`,
          now,
        });
      } catch (error) {
        // 范围被**其它恢复**占用 ⇒ 本次同样一个字都没写 ⇒ 不走回滚路径。
        // 原始异常只进服务端日志，对外只给受控说明（不含本机路径）。
        this.logger.warn(
          { err: error, restoreId: input.restoreId },
          '恢复范围已被其它恢复占用，本次恢复受控拒绝',
        );
        return this.failed(
          input.restoreId,
          LOCAL_RESTORE_EXECUTION_REASON_CODES.SCOPE_OCCUPIED,
          RESTORE_FAILURE_REASON_TEXT.SCOPE_OCCUPIED,
          true,
        );
      }

      const restored = await this.restoreScope({
        run: activeRun,
        source: activeSource,
        installationId: installation.installationId,
      });

      // ② 核验：逐表行数必须与清单一致（由来源域按真实事实给出）
      const verified = await this.verifyScope(
        activeRun,
        restored.expectedRows,
        installation.installationId,
      );
      if (!verified.ok) {
        return await this.failAfterWrite(
          input.restoreId,
          activeRun,
          activeProtection,
          installation,
          now,
          LOCAL_RESTORE_EXECUTION_REASON_CODES.VERIFY_FAILED,
          verified.reason,
          input.actorAccountId,
          input.actorAdminLevel,
        );
      }

      // ③ **终态发布**（任务 09 独立验收 P1-3）：运行终态与最终审计**同一事务**
      //    ⇒ 不会出现"事件成功但状态没写"或"状态写成功但事件缺失"的分裂终态。
      //    发布顺序：**先终态、后解冻**——解冻失败时终态仍是"成功"，
      //    不会回滚、也不会再补一条 FAILED ⇒ 不出现"成功＋失败"双终态。
      const published = await this.publishRestoreTerminal({
        restoreId: activeRun.restoreId,
        status: 'SUCCEEDED',
        finishedAt: now,
        restoredScope: JSON.stringify(restored.counts),
        resultSummary: JSON.stringify({
          status: 'SUCCEEDED',
          restored: restored.counts,
          finishedAt: now.toISOString(),
        }),
        event: {
          stage: LOCAL_RESTORE_AUDIT_STAGES.EXECUTION_SUCCEEDED,
          reasonCode: null,
          counts: restored.counts,
          actorAccountId: input.actorAccountId,
          actorAdminLevel: input.actorAdminLevel,
          organizationId: activeRun.organizationId,
          backupId: activeRun.backupId,
          protectionBackupId: activeRun.protectionBackupId ?? null,
        },
      });
      if (!published.published) {
        // 终态已被其它执行发布：不得覆盖、不得重复发布事件（同一事实只留一条）
        this.logger.error(
          { restoreId: activeRun.restoreId, reason: published.reason },
          '恢复终态已被其它执行发布，本次不重复发布终态',
        );
        return this.failed(
          input.restoreId,
          LOCAL_RESTORE_EXECUTION_REASON_CODES.ALREADY_TERMINAL,
          '该恢复已结束，不能重复执行',
          await this.isCompanyFrozen(installation.installationId, activeRun.organizationId),
        );
      }

      // ④ 解除冻结（**带所有权**：只能解冻自己持有的那一条）
      //    终态已发布 ⇒ 这里失败**不回滚、不改判失败**：数据确实已恢复成功，
      //    只是停写停传还没解除 ⇒ 如实回报"成功但冻结保留"，并补一条留痕。
      let released = true;
      try {
        await this.localWriteHoldService.release({
          installationId: installation.installationId,
          organizationId: activeRun.organizationId,
          restoreId: activeRun.restoreId,
          now,
        });
      } catch (error) {
        released = false;
        this.logger.error(
          { err: error, restoreId: activeRun.restoreId },
          '恢复成功但冻结解除失败（设备继续停写停传，需人工处置）',
        );
        // 补充事实：**仍是成功终态**，只是冻结未解除 ⇒ 不与成功终态矛盾
        await this.appendRestoreEvent({
          restoreId: activeRun.restoreId,
          actorAccountId: input.actorAccountId,
          actorAdminLevel: input.actorAdminLevel,
          organizationId: activeRun.organizationId,
          backupId: activeRun.backupId,
          protectionBackupId: activeRun.protectionBackupId ?? null,
          result: 'SUCCEEDED',
          stage: LOCAL_RESTORE_AUDIT_STAGES.EXECUTION_SUCCEEDED_HOLD_RETAINED,
        }).catch((error: unknown) => {
          this.logger.error(
            { err: error, restoreId: activeRun.restoreId },
            '恢复成功但冻结未解除的补充留痕写入失败（尽力而为，不改判恢复结果）',
          );
        });
      }

      // 恢复运行时检查（任务书第 52 行「每日及恢复运行检查」）：挂在**冻结解除之后**，
      // 此时该公司的写入冻结已释放，过期清理的冻结闸门不再拦它。
      // 冻结未解除时**不**跑（清理会被闸门拦住，跑也只是徒劳）。
      if (released) {
        await this.runRetentionCheckOnRestore();
      }
      return {
        status: 'SUCCEEDED',
        restoreId: activeRun.restoreId,
        restored: restored.counts,
        released,
        holdRetained: !released,
      };
    } catch (error) {
      // 原始异常（绝对路径／SQL 片段）**只进服务端日志**；对外只给受控说明
      this.logger.error(
        { err: error, restoreId: input.restoreId },
        '恢复执行失败（原始异常只进服务端日志）',
      );
      return await this.failAfterWrite(
        input.restoreId,
        activeRun,
        activeProtection,
        installation,
        now,
        LOCAL_RESTORE_EXECUTION_REASON_CODES.EXECUTION_FAILED,
        RESTORE_FAILURE_REASON_TEXT.EXECUTION_FAILED,
        input.actorAccountId,
        input.actorAdminLevel,
      );
    } finally {
      // 执行权必须释放（否则同一次恢复再也执行不了）；
      // 进程崩溃时锁由数据库自动释放 ⇒ 中断后仍可重新执行收口。
      await executionLock?.release();
    }
  }

  /**
   * **重新读取／锁定最新运行事实并原子占用**（任务 09 独立验收 P1-2）。
   *
   * 口径：
   * - 锁定读（`FOR UPDATE`）取**最新已提交**的事实（不是事务快照里的旧值），
   *   并对该行加排他锁 ⇒ 判定期间不会有别人改写它；
   * - 重新校验：状态（必须仍是 RUNNING）、预检（PASSED）、确认（非空）、
   *   保护副本（非空）、公司（执行人授权范围内）、安装（目标是本机）；
   * - 条件更新（CAS）**原子占用**：占用标记写在 `result_summary` 上，
   *   条件里带上"仍是 RUNNING 且预检通过"⇒ 任一不成立都**不产生任何写入**。
   *
   * 中断后的收口：进程被打断时运行行仍是 RUNNING ⇒ 再次执行**仍可占用**
   * （不会把合法收口永久拒掉）；但**已终态**的行不再被占用 ⇒
   * 延迟到达的重复请求只会得到受控拒绝，**不会再执行旧备份**。
   */
  private async claimRestoreExecution(input: {
    restoreId: string;
    actorAccountId: number;
    /** 实际执行人的管理员等级（占用事实与终态审计都要用它） */
    actorAdminLevel: LocalRuntimeAdminLevel;
    installationId: string;
    allowedOrganizationId: number | null;
    now: Date;
  }): Promise<
    | { ok: true; run: BackupRestoreRunEntity; organizationId: number }
    | { ok: false; reasonCode: string; reason: string; organizationId: number | null }
  > {
    return await this.restoreRunRepository.manager.transaction(async (manager) => {
      const repository = manager.getRepository(BackupRestoreRunEntity);
      // ① 锁定读：最新已提交事实 + 排他行锁（当前读，不受事务快照回退影响）
      const fresh = await repository.findOne({
        where: { restoreId: input.restoreId },
        lock: { mode: 'pessimistic_write' },
      });
      if (fresh === null) {
        return {
          ok: false,
          reasonCode: LOCAL_RESTORE_EXECUTION_REASON_CODES.RUN_NOT_FOUND,
          reason: '恢复运行不存在',
          organizationId: null,
        };
      }
      const organizationId = fresh.organizationId;
      // ② 重新校验全部闸门（**以最新事实为准**）
      if (fresh.status !== 'RUNNING') {
        // 已是终态（成功／失败／中断）⇒ 不得再次执行旧备份
        return {
          ok: false,
          reasonCode: LOCAL_RESTORE_EXECUTION_REASON_CODES.ALREADY_TERMINAL,
          reason: '该恢复已结束，不能重复执行',
          organizationId,
        };
      }
      if (fresh.checkStatus !== 'PASSED') {
        return {
          ok: false,
          reasonCode: LOCAL_RESTORE_EXECUTION_REASON_CODES.CHECK_NOT_PASSED,
          reason: '恢复预检未通过',
          organizationId,
        };
      }
      if (fresh.confirmation === null || fresh.confirmation === undefined) {
        return {
          ok: false,
          reasonCode: LOCAL_RESTORE_EXECUTION_REASON_CODES.NOT_ACCEPTED,
          reason: '恢复未受理',
          organizationId,
        };
      }
      if (fresh.protectionBackupId === null || fresh.protectionBackupId === '') {
        return {
          ok: false,
          reasonCode: LOCAL_RESTORE_EXECUTION_REASON_CODES.NOT_ACCEPTED,
          reason: '恢复未受理',
          organizationId,
        };
      }
      if (
        input.allowedOrganizationId !== null &&
        fresh.organizationId !== input.allowedOrganizationId
      ) {
        // 跨公司执行 ⇒ 受控拒绝（执行人无权操作该公司数据区）
        return {
          ok: false,
          reasonCode: LOCAL_RESTORE_EXECUTION_REASON_CODES.ORGANIZATION_NOT_ALLOWED,
          reason: '无权执行该公司的恢复',
          organizationId,
        };
      }
      if (
        fresh.targetInstallationId !== null &&
        fresh.targetInstallationId !== input.installationId
      ) {
        // 异机执行 ⇒ 受控拒绝（历史未知为 NULL 时不拦）
        return {
          ok: false,
          reasonCode: LOCAL_RESTORE_EXECUTION_REASON_CODES.INSTALLATION_MISMATCH,
          reason: '该恢复不是本机发起的，不能在本机执行',
          organizationId,
        };
      }
      // ③ **原子占用**（条件更新）：条件不成立 ⇒ 影响行数为 0 ⇒ 不产生任何写入
      const claimed = await repository.update(
        {
          restoreId: fresh.restoreId,
          status: 'RUNNING',
          checkStatus: 'PASSED',
        },
        {
          // 占用标记（可追溯的执行占用事实；终态发布时被终态摘要覆盖）
          resultSummary: JSON.stringify({
            claim: {
              restoreId: fresh.restoreId,
              actorAccountId: input.actorAccountId,
              actorAdminLevel: input.actorAdminLevel,
              claimedAt: input.now.toISOString(),
            },
          }),
        },
      );
      if ((claimed.affected ?? 0) !== 1) {
        // 条件不再成立（已被别人终态化／占用）⇒ 受控拒绝，零写入
        return {
          ok: false,
          reasonCode: LOCAL_RESTORE_EXECUTION_REASON_CODES.ALREADY_TERMINAL,
          reason: '该恢复已结束，不能重复执行',
          organizationId,
        };
      }
      return { ok: true, run: fresh, organizationId };
    });
  }

  /**
   * **终态发布协议**（任务 09 独立验收 P1-3）。
   *
   * 运行终态（`backup_restore_run`）与最终审计（`management_audit_event`）
   * 在**同一个数据库事务**里落地 ⇒ 只有两种可能：
   * - 两者都成功：终态与审计一致；
   * - 两者都回滚：不留半截事实（不会出现"事件成功但状态没写"）。
   *
   * 条件更新（CAS）保证**同一事实只留一条**：
   * 只有仍处于 RUNNING 的行才能被终态化 ⇒ 已被别的执行终态化的行不会被覆盖，
   * 也不会再写第二条终态事件。
   */
  private async publishRestoreTerminal(input: {
    restoreId: string;
    status: 'SUCCEEDED' | 'FAILED';
    finishedAt: Date;
    restoredScope?: string | null;
    resultSummary?: string | null;
    /**
     * 最终审计事件（null＝本次不写事件：调用方没有操作者事实时，
     * 例如"执行权未取得"这类零写入拒绝——它们本来就不该留下终态）。
     */
    event: {
      stage: LocalRestoreAuditStage;
      reasonCode: string | null;
      counts?: { records: number; originals: number; queue: number } | null;
      actorAccountId: number;
      /** 实际执行人的管理员等级（审计事实必须是真实等级，不固定记一级） */
      actorAdminLevel: LocalRuntimeAdminLevel;
      organizationId: number;
      backupId: string;
      protectionBackupId: string | null;
    } | null;
  }): Promise<{ published: boolean; reason: string | null }> {
    return await this.restoreRunRepository.manager.transaction(async (manager) => {
      const repository = manager.getRepository(BackupRestoreRunEntity);
      // ① 条件更新（CAS）：只有仍处于 RUNNING 的行才能被终态化
      const affected = await repository.update(
        { restoreId: input.restoreId, status: 'RUNNING' },
        {
          status: input.status,
          finishedAt: input.finishedAt,
          // 库级 CHECK `chk_backup_restore_run_check_outcome`：
          // 终态 FAILED／INTERRUPTED 的行**不得**带核对结论
          ...(input.status === 'FAILED' ? { checkStatus: null } : {}),
          ...(input.restoredScope === undefined ? {} : { restoredScope: input.restoredScope }),
          ...(input.resultSummary === undefined ? {} : { resultSummary: input.resultSummary }),
        },
      );
      if ((affected.affected ?? 0) !== 1) {
        return {
          published: false,
          reason: '恢复运行已被其它执行终态化，本次不重复发布终态',
        };
      }
      // ② 最终审计事件：**与运行终态同一事务**（同一事实，两处落地）
      if (input.event !== null) {
        await this.appendRestoreEvent({
          restoreId: input.restoreId,
          actorAccountId: input.event.actorAccountId,
          actorAdminLevel: input.event.actorAdminLevel,
          organizationId: input.event.organizationId,
          backupId: input.event.backupId,
          protectionBackupId: input.event.protectionBackupId,
          result: input.status,
          stage: input.event.stage,
          reasonCode: input.event.reasonCode,
          counts: input.event.counts ?? undefined,
          transactionContext: createTypeOrmPersistenceTransactionContext(manager),
        });
      }
      return { published: true, reason: null };
    });
  }

  /**
   * 该公司数据区当前是否**仍在停写停传**（如实回报 `holdRetained`）。
   *
   * 读不到冻结事实时**保守**按"仍在冻结"回报：宁可多报停写停传，
   * 也不把"设备仍被冻结"说成"已解除"。
   */
  private async isCompanyFrozen(
    installationId: string,
    organizationId: number | null,
  ): Promise<boolean> {
    if (organizationId === null) {
      return false;
    }
    try {
      const holds = await this.localWriteHoldService.listActive({
        installationId,
        organizationId,
      });
      return holds.length > 0;
    } catch (error) {
      this.logger.error(
        { err: error, installationId, organizationId },
        '读取冻结事实失败（按仍在冻结保守回报）',
      );
      return true;
    }
  }

  /**
   * 恢复运行时触发的过期清理检查。
   *
   * 失败关闭：清理本身出错**不得**把已成功的恢复改判为失败——
   * 恢复事实已经落库（状态、审计事件、冻结解除都已完成），
   * 清理只是"顺带做一次回收"，出错只记日志并保留逐项结果（由清理链自己落库）。
   */
  private async runRetentionCheckOnRestore(): Promise<void> {
    const cleanupService = this.backupCleanupService;
    if (cleanupService === undefined) {
      return;
    }
    try {
      const result = await cleanupService.cleanupAllExpiredPackages();
      if (result.targetCount > 0 || result.cleaned > 0) {
        this.logger.info(
          { targets: result.targetCount, cleaned: result.cleaned },
          '恢复运行时过期清理检查已执行',
        );
      }
    } catch (error) {
      this.logger.error({ err: error }, '恢复运行时过期清理检查失败（不影响恢复结果）');
    }
  }

  /**
   * 取得一次恢复运行的**执行权**（数据库级互斥，G30–G33）。
   *
   * 用 MySQL 命名锁（`GET_LOCK`）：
   * - 由**数据库**持有 ⇒ 跨进程、跨连接互斥（浏览器重复点击／Worker 重投都拦得住）；
   * - **进程崩溃或连接断开时自动释放** ⇒ 中断的恢复不会留下"永远占着执行权"的死锁，
   *   运维可以重新执行收口（这是"崩溃恢复"要求的硬条件）；
   * - `GET_LOCK(name, 0)` 不等待：抢不到**立即**受控拒绝，不静默排队。
   *
   * 锁名按 `restoreId` 归一 ⇒ 与 `LocalWriteHoldService` 的**范围锁**名字不同，
   * 两把锁不会互相等待（否则同进程内先取范围锁再取执行锁会自死锁）。
   */
  private async tryAcquireExecutionLock(
    restoreId: string,
  ): Promise<{ release(): Promise<void> } | null> {
    try {
      return await this.acquireExecutionLock(restoreId);
    } catch (error) {
      this.logger.warn(
        { err: error, restoreId },
        '恢复执行权未取得（并发执行或锁不可得），本次恢复受控拒绝',
      );
      return null;
    }
  }

  private async acquireExecutionLock(restoreId: string): Promise<{ release(): Promise<void> }> {
    const lockName = `task09:exec:${createHash('sha1').update(restoreId).digest('hex')}`;
    // 用**仓储的 manager**取独占连接：本模块没有 DataSource provider
    // （`DataSource` 只在应用根模块可用）⇒ 从 `Repository.manager.connection` 取等价能力。
    const queryRunner = this.restoreRunRepository.manager.connection.createQueryRunner();
    await queryRunner.connect();
    const acquired = await this.tryGetLock(queryRunner, lockName);
    if (!acquired) {
      await queryRunner.release().catch(() => undefined);
      throw new Error(`该恢复正在执行中（${restoreId}），不接受并发执行`);
    }
    return {
      release: async () => {
        try {
          const released: unknown = await queryRunner.query(
            'SELECT RELEASE_LOCK(?) AS `released`',
            [lockName],
          );
          const releasedValue = Number(
            (released as Array<{ released: number | null }>)[0]?.released ?? 0,
          );
          if (releasedValue !== 1) {
            this.logger.error(
              { lockName, released: releasedValue, restoreId },
              '恢复执行锁未能显式释放（连接断开时由数据库自动释放）',
            );
          }
        } catch (error) {
          // 连接已断 ⇒ 数据库已自动释放锁；连接仍活但释放失败 ⇒ 记录并保留（失败关闭）
          this.logger.error(
            { err: error, lockName, restoreId },
            '恢复执行锁释放异常（连接断开时由数据库自动释放）',
          );
        } finally {
          await queryRunner.release().catch(() => undefined);
        }
      },
    };
  }

  /** 尝试取得数据库命名锁（不等待；抢不到立即返回 false） */
  private async tryGetLock(
    queryRunner: { query(sql: string, parameters?: unknown[]): Promise<unknown> },
    lockName: string,
  ): Promise<boolean> {
    const rows = (await queryRunner.query('SELECT GET_LOCK(?, 0) AS `locked`', [
      lockName,
    ])) as Array<{ locked: number | null }>;
    return Number(rows[0]?.locked ?? 0) === 1;
  }

  /**
   * 写入阶段失败后的处置（任务 09 S2-5）。
   *
   * - 先按**保护副本**把本次恢复改动的范围回滚到恢复前状态；
   * - 回滚成功 ⇒ 业务数据与原件保持恢复前事实，可解除冻结，终态 FAILED；
   * - 回滚失败 ⇒ **保持停写停传**并保留保护副本，等人工处置。
   */
  private async failAfterWrite(
    restoreId: string,
    run: BackupRestoreRunEntity,
    protection: BackupAssetEntity | null,
    installation: LocalInstallationEntity,
    now: Date,
    reasonCode: string,
    reason: string,
    actorAccountId: number,
    actorAdminLevel: LocalRuntimeAdminLevel,
  ): Promise<LocalRestoreExecutionOutcome> {
    const rollback = await this.rollbackToProtection(run, protection, installation.installationId);
    if (!rollback.ok) {
      return await this.failAndKeepHold(
        restoreId,
        reasonCode,
        `${reason}（按保护副本回滚失败：${rollback.reason ?? '原因不可用'}）`,
        {
          actorAccountId,
          actorAdminLevel,
          organizationId: run.organizationId,
          backupId: run.backupId,
          protectionBackupId: run.protectionBackupId ?? null,
          stage: LOCAL_RESTORE_AUDIT_STAGES.EXECUTION_ROLLBACK_FAILED,
        },
      );
    }
    try {
      await this.localWriteHoldService.release({
        installationId: installation.installationId,
        organizationId: run.organizationId,
        restoreId: run.restoreId,
        now,
      });
    } catch {
      // 冻结解除失败不影响"数据已回滚"的结论，但设备仍停写停传（保守口径）
      // 这条路径是**必须留痕的终态**：设备仍在冻结、需人工处置，
      // 不能因为"事件尽力而为"就整条丢掉（否则任务 10 页看不到这次恢复尝试）。
      return await this.failAndKeepHold(
        restoreId,
        reasonCode,
        `${reason}（业务数据已按保护副本回滚，但冻结解除失败，设备继续停写停传）`,
        {
          actorAccountId,
          actorAdminLevel,
          organizationId: run.organizationId,
          backupId: run.backupId,
          protectionBackupId: run.protectionBackupId ?? null,
          stage: LOCAL_RESTORE_AUDIT_STAGES.EXECUTION_HOLD_RETAINED,
        },
      );
    }
    // 终态发布（运行终态 ＋ 最终审计**同一事务**，P1-3）：
    // 数据已回滚、冻结已解除 ⇒ 终态就是"失败且已回滚"，不再有第二条终态。
    const published = await this.publishRestoreTerminal({
      restoreId,
      status: 'FAILED',
      finishedAt: now,
      resultSummary: JSON.stringify({
        status: 'FAILED',
        reasonCode,
        rolledBack: true,
        finishedAt: now.toISOString(),
      }),
      event: {
        stage: LOCAL_RESTORE_AUDIT_STAGES.EXECUTION_ROLLED_BACK,
        reasonCode,
        actorAccountId,
        actorAdminLevel,
        organizationId: run.organizationId,
        backupId: run.backupId,
        protectionBackupId: run.protectionBackupId ?? null,
      },
    }).catch((error: unknown) => {
      // 终态发布失败**不得**反过来打断失败处置（此时数据已回滚、冻结已解除）；
      // 运行行仍是 RUNNING ⇒ 后续可重新执行收口（不会被永久拒绝）。
      this.logger.error(
        { err: error, restoreId },
        '恢复失败终态发布失败（运行行仍为 RUNNING，待重新执行收口）',
      );
      return { published: false, reason: '终态发布失败' };
    });
    if (!published.published) {
      this.logger.error(
        { restoreId, reason: published.reason },
        '恢复失败终态未发布（已被其它执行终态化，不重复发布）',
      );
    }
    return {
      status: 'FAILED',
      restoreId,
      reasonCode,
      reason: `${reason}（业务数据与原件已按保护副本回滚，本机保持恢复前状态）`,
      holdRetained: false,
    };
  }

  /**
   * 写恢复终态事件（任务 09 S2-6，供任务 10 读）。
   *
   * 事件写不进去**如实抛出**：终态事件缺失时，不能让调用方以为"恢复已留痕"。
   */
  private async appendRestoreEvent(input: {
    restoreId: string;
    actorAccountId: number;
    /** 实际执行人的管理员等级（**真实等级**，不固定记一级） */
    actorAdminLevel: LocalRuntimeAdminLevel;
    organizationId: number;
    backupId: string;
    protectionBackupId: string | null;
    result: 'SUCCEEDED' | 'FAILED';
    stage: LocalRestoreAuditStage;
    reasonCode?: string | null;
    counts?: { records: number; originals: number; queue: number };
    /**
     * 事务上下文：终态发布时与运行终态**同一事务** ⇒
     * "运行终态"与"最终审计"不会分裂成两条互相矛盾的事实。
     */
    transactionContext?: PersistenceTransactionContext;
  }): Promise<void> {
    await this.managementAuditService.appendRestoreEvent({
      actorAccountId: input.actorAccountId,
      actorAdminLevel: input.actorAdminLevel,
      organizationId: input.organizationId,
      operation: 'RESTORE_LOCAL_BUSINESS',
      restoreId: input.restoreId,
      backupId: input.backupId,
      protectionBackupId: input.protectionBackupId,
      result: input.result,
      stage: input.stage,
      reasonCode: input.reasonCode ?? null,
      counts: input.counts,
      ...(input.transactionContext === undefined
        ? {}
        : { transactionContext: input.transactionContext }),
    });
  }

  /**
   * 按**保护副本**回滚本次恢复改动的范围（任务 09 S2-5）。
   *
   * 保护副本是恢复前状态的一份受保护备份（同一包格式），因此回滚复用
   * 同一套"整体替换＋原件还原"链路，而不是另写一套逆向补丁。
   */
  private async rollbackToProtection(
    run: BackupRestoreRunEntity,
    protection: BackupAssetEntity | null,
    installationId: string,
  ): Promise<{ ok: boolean; reason: string | null }> {
    if (
      protection === null ||
      protection.localReference === null ||
      protection.localReference === ''
    ) {
      return { ok: false, reason: LOCAL_BACKUP_FAILURE_REASON.RESTORE_PROTECTION_UNREADABLE };
    }
    try {
      await this.restoreScope({ run, source: protection, installationId });
      return { ok: true, reason: null };
    } catch (error) {
      // 原始异常（绝对路径／SQL 片段）**只进服务端日志**，对外只给受控原因码
      this.logger.error({ err: error, restoreId: run.restoreId }, '按保护副本回滚失败');
      return { ok: false, reason: LOCAL_BACKUP_FAILURE_REASON.RESTORE_ROLLBACK_FAILED };
    }
  }

  /** 读取本机保护密钥材料（不可得即 null） */
  private readProtectionKey(): Buffer | null {
    try {
      return parseProtectionKey(this.backupProtection?.keyHex ?? null);
    } catch {
      return null;
    }
  }

  /**
   * 按清单恢复：业务数据（中立受控端口，整体替换）＋ 原件字节还原。
   *
   * - 业务数据写入端口未注册 ⇒ 抛错 ⇒ 上层按"失败并保持冻结"处理（不静默跳过）；
   * - 载荷里的表必须都在**范围快照**里（范围与载荷不一致即失败关闭）；
   * - 业务表与原件字节都交给来源域的受控入口写回，恢复编排不直接改业务行。
   */
  private async restoreScope(input: {
    run: BackupRestoreRunEntity;
    source: BackupAssetEntity | null;
    /** 本机安装标识（本机运行数据按安装 × 公司圈定范围时需要） */
    installationId: string;
  }): Promise<{
    counts: { records: number; originals: number; queue: number };
    expectedRows: Record<string, number>;
  }> {
    const { run, source } = input;
    if (source === null || source.localReference === null || source.localReference === '') {
      throw new Error('被恢复的本地包已不存在或不可读');
    }
    const manifest = parseBackupManifest(
      JSON.parse(readFileSync(join(source.localReference, 'manifest.json'), 'utf8')),
    );
    const key = this.readProtectionKey();
    if (key === null) {
      throw new Error('受保护包解密材料不可得');
    }
    const payload = JSON.parse(
      decryptBackupPayload(
        key,
        readFileSync(join(source.localReference, BACKUP_PAYLOAD_PATH)),
        manifest.encryption.iv,
        manifest.encryption.auth_tag,
      ).toString('utf8'),
    ) as Record<string, Record<string, unknown>[]>;

    const expectedRows: Record<string, number> = {};
    for (const entry of manifest.scope) {
      expectedRows[entry.table] = entry.rowCount;
    }

    // 范围与载荷必须一致：载荷里出现范围快照没有的表 ⇒ 失败关闭
    const scopeTables = new Set<string>(manifest.scope.map((entry) => entry.table));
    for (const table of Object.keys(payload)) {
      if (!scopeTables.has(table)) {
        throw new Error(`备份包范围快照与数据载荷不一致（${table} 不在范围快照内）`);
      }
    }

    const writer = this.resolveRecordWriter();
    const tables = Object.entries(payload).map(([table, rows]) => ({
      table: table as LocalRestoreRecordTable,
      rows,
    }));
    const outcome = await writer.write({
      organizationId: run.organizationId,
      installationId: input.installationId,
      restoreId: run.restoreId,
      tables,
    });
    if (outcome.status === 'FAILED') {
      throw new Error(outcome.reason ?? '业务数据恢复失败');
    }

    // 原件字节：按包内清单核对后写回本地存储（来源域受控入口）
    const originals = await writer.restoreOriginals({
      organizationId: run.organizationId,
      restoreId: run.restoreId,
      packageRoot: source.localReference,
      originals: manifest.originals,
      files: manifest.files,
    });
    if (originals.failed > 0) {
      throw new Error(originals.reason ?? '原件字节还原失败');
    }

    const queue = outcome.counts['local_upload_task'] ?? 0;
    return {
      counts: { records: outcome.written, originals: originals.restored, queue },
      expectedRows,
    };
  }

  /** 解析业务数据受控写入实现；未注册即失败关闭 */
  private resolveRecordWriter(): LocalRestoreRecordWriter {
    let writer: LocalRestoreRecordWriter | null;
    try {
      writer = this.moduleRef.get<LocalRestoreRecordWriter>(LOCAL_RESTORE_RECORD_WRITER, {
        strict: false,
      });
    } catch {
      writer = null;
    }
    if (writer === null || writer === undefined) {
      throw new Error('业务数据受控写入入口未注册，不能恢复业务数据');
    }
    return writer;
  }

  /** 核验：逐表行数与清单一致（行数由来源域按真实事实给出） */
  private async verifyScope(
    run: BackupRestoreRunEntity,
    expectedRows: Record<string, number>,
    installationId: string,
  ): Promise<{ ok: boolean; reason: string }> {
    const writer = this.resolveRecordWriter();
    for (const [table, expected] of Object.entries(expectedRows)) {
      if (table === 'local_backup_run') {
        // 本机运行事实表不进恢复载荷，也不参与写回核验。
        continue;
      }
      const actual = await writer.count({
        organizationId: run.organizationId,
        installationId,
        table: table as LocalRestoreRecordTable,
      });
      if (actual !== expected) {
        // 明细（表名与行数）只进服务端日志：对外字段不出现库表结构与计数明细
        this.logger.error(
          { table, actual, expected, restoreId: run.restoreId },
          '恢复核验失败：写回行数与清单不一致',
        );
        return {
          ok: false,
          reason: RESTORE_FAILURE_REASON_TEXT.VERIFY_FAILED,
        };
      }
    }
    return { ok: true, reason: '' };
  }

  /**
   * 失败且**保持冻结**：写终态、保留保护副本与任务。
   *
   * 这条路径＝"写入失败 **且** 回滚也失败" ⇒ 设备继续停写停传，
   * 是**必须留痕**的终态（任务 09 新计划第 06 项）：终态事件照写，
   * 阶段标成"回滚失败"，供任务 10 页读出真实原因。
   */
  private async failAndKeepHold(
    restoreId: string,
    reasonCode: string,
    reason: string,
    audit?: {
      readonly actorAccountId: number;
      /** 实际执行人的管理员等级（终态审计事实必须是真实等级） */
      readonly actorAdminLevel: LocalRuntimeAdminLevel;
      readonly organizationId: number;
      readonly backupId: string;
      readonly protectionBackupId: string | null;
      readonly stage: LocalRestoreAuditStage;
    },
  ): Promise<LocalRestoreExecutionOutcome> {
    // 终态发布（运行终态 ＋ 最终审计**同一事务**，P1-3）：
    // 失败且保留冻结也是**一个**终态（阶段＝回滚失败／冻结未解除），
    // 不会与先前的成功事件并存成"成功＋失败"双终态。
    const published = await this.publishRestoreTerminal({
      restoreId,
      status: 'FAILED',
      finishedAt: new Date(),
      resultSummary: JSON.stringify({
        status: 'FAILED',
        reasonCode,
        holdRetained: true,
      }),
      event:
        audit === undefined
          ? null
          : {
              stage: audit.stage,
              reasonCode,
              actorAccountId: audit.actorAccountId,
              actorAdminLevel: audit.actorAdminLevel,
              organizationId: audit.organizationId,
              backupId: audit.backupId,
              protectionBackupId: audit.protectionBackupId,
            },
    }).catch((error: unknown) => {
      // 终态发布失败**不改变**"保持冻结"的结论（设备仍停写停传），
      // 但必须留痕：完全静默会让"这次恢复尝试为什么没有终态"无从查起。
      this.logger.error(
        { err: error, restoreId },
        '恢复终态发布失败（尽力而为，不影响保持冻结的结论）',
      );
      return { published: false, reason: '终态发布失败' };
    });
    if (!published.published) {
      this.logger.error(
        { restoreId, reason: published.reason },
        '恢复失败终态未发布（已被其它执行终态化，不重复发布）',
      );
    }
    return this.failed(restoreId, reasonCode, reason, true);
  }

  private failed(
    restoreId: string,
    reasonCode: string,
    reason: string,
    holdRetained: boolean,
  ): LocalRestoreExecutionOutcome {
    return { status: 'FAILED', restoreId, reasonCode, reason, holdRetained };
  }
}
