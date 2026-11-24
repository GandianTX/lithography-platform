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

import {
  BACKUP_PAYLOAD_PATH,
  decryptBackupPayload,
  parseBackupManifest,
  parseProtectionKey,
} from '@core/local-runtime/policy/protected-backup.policy';
import { LOCAL_BACKUP_FAILURE_REASON } from '@core/local-runtime/policy/local-backup-failure-reason';
import { resolveRestoreExecutionCapability } from '@core/local-runtime/policy/restore-execution-capability.policy';
import {
  LOCAL_RESTORE_AUDIT_STAGES,
  type LocalRestoreAuditStage,
} from '@core/local-runtime/policy/local-restore-audit.policy';

import { ManagementAuditService } from './management-audit.service';
import { BackupAssetEntity } from './entities/backup-asset.entity';
import { BackupRestoreRunEntity } from './entities/backup-restore-run.entity';
import { LocalInstallationEntity } from './entities/local-installation.entity';
import { LocalBackupCleanupService } from './local-backup-cleanup.service';
import { LocalWriteHoldService } from './local-write-hold.service';

import {
  LOCAL_BACKUP_PROTECTION,
  type ProtectedBackupMaterial,
} from '@usecases/common/ports/protected-backup.contract';
import {
  LOCAL_RESTORE_RECORD_WRITER,
  type LocalRestoreRecordTable,
  type LocalRestoreRecordWriter,
} from '@usecases/common/ports/local-restore-record-writer.contract';

/** 恢复执行结论 */
export type LocalRestoreExecutionOutcome =
  | {
      status: 'SUCCEEDED';
      restoreId: string;
      /** 逐项恢复计数 */
      restored: { records: number; originals: number; queue: number };
      /** 冻结是否已解除 */
      released: boolean;
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
   */
  async execute(input: {
    restoreId: string;
    actorAccountId: number;
    now?: Date;
  }): Promise<LocalRestoreExecutionOutcome> {
    const now = input.now ?? new Date();
    const run = await this.restoreRunRepository.findOne({
      where: { restoreId: input.restoreId },
    });
    if (run === null) {
      return this.failed(input.restoreId, 'RESTORE_RUN_NOT_FOUND', '恢复运行不存在', false);
    }
    if (run.status !== 'RUNNING') {
      return this.failed(
        input.restoreId,
        'RESTORE_NOT_ACCEPTED',
        '恢复未被受理或已结束，不能重复执行',
        false,
      );
    }
    if (run.checkStatus !== 'PASSED') {
      return this.failed(input.restoreId, 'RESTORE_CHECK_NOT_PASSED', '恢复预检未通过', false);
    }
    if (run.confirmation === null || run.confirmation === undefined) {
      return this.failed(input.restoreId, 'RESTORE_NOT_ACCEPTED', '恢复未受理', false);
    }

    const installation = await this.installationRepository.findOne({ where: { id: 1 } });
    if (installation === null) {
      return this.failed(
        input.restoreId,
        'RESTORE_INSTALLATION_MISSING',
        '本机安装身份未初始化',
        false,
      );
    }

    const source = await this.backupAssetRepository.findOne({
      where: { backupId: run.backupId },
    });
    const protection = await this.backupAssetRepository.findOne({
      where: { backupId: run.protectionBackupId ?? '' },
    });
    const protectionReady =
      protection !== null && protection.localStatus !== 'CLEANED' && !!protection.localReference;

    // 三道闸门（core 策略裁决）：缺任一闸门即如实不可用
    const capability = resolveRestoreExecutionCapability({
      writeGateReady: true,
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
        'RESTORE_EXECUTION_ALREADY_RUNNING',
        '该恢复正在执行中，不接受并发执行',
        true,
      );
    }

    try {
      // ① 冻结（先于任何写入）：恢复期间目标公司数据区停写停传
      try {
        await this.localWriteHoldService.hold({
          installationId: installation.installationId,
          organizationId: run.organizationId,
          restoreId: run.restoreId,
          reason: `恢复执行中（${run.restoreId}）`,
          now,
        });
      } catch (error) {
        // 范围被**其它恢复**占用 ⇒ 本次同样一个字都没写 ⇒ 不走回滚路径。
        const reason = error instanceof Error ? error.message : '恢复范围已被其它恢复占用';
        return this.failed(input.restoreId, 'RESTORE_SCOPE_OCCUPIED', reason, true);
      }

      const restored = await this.restoreScope({
        run,
        source,
        installationId: installation.installationId,
      });

      // ② 核验：逐表行数必须与清单一致（由来源域按真实事实给出）
      const verified = await this.verifyScope(
        run,
        restored.expectedRows,
        installation.installationId,
      );
      if (!verified.ok) {
        return await this.failAfterWrite(
          input.restoreId,
          run,
          protection,
          installation,
          now,
          'RESTORE_VERIFY_FAILED',
          verified.reason,
          input.actorAccountId,
        );
      }

      // ③ 终态事件**先写**：写不进去就不算恢复成功（任务 10 读不到事实时，
      //    不能既宣布成功又解除冻结）——事件写失败会被上面的 catch 捕获并按
      //    "失败并回滚"处理，避免留下"数据已恢复但无人知晓"的不可解释状态。
      await this.appendRestoreEvent({
        restoreId: run.restoreId,
        actorAccountId: input.actorAccountId,
        organizationId: run.organizationId,
        backupId: run.backupId,
        protectionBackupId: run.protectionBackupId ?? null,
        result: 'SUCCEEDED',
        stage: LOCAL_RESTORE_AUDIT_STAGES.EXECUTION_SUCCEEDED,
        counts: restored.counts,
      });

      // ④ 解除冻结（**带所有权**：只能解冻自己持有的那一条）
      await this.localWriteHoldService.release({
        installationId: installation.installationId,
        organizationId: run.organizationId,
        restoreId: run.restoreId,
        now,
      });
      await this.restoreRunRepository.update(
        { restoreId: run.restoreId },
        {
          status: 'SUCCEEDED',
          finishedAt: now,
          restoredScope: JSON.stringify(restored.counts),
        },
      );
      // 恢复运行时检查（任务书第 52 行「每日及恢复运行检查」）：挂在**冻结解除之后**，
      // 此时该公司的写入冻结已释放，过期清理的冻结闸门不再拦它。
      await this.runRetentionCheckOnRestore();
      return {
        status: 'SUCCEEDED',
        restoreId: run.restoreId,
        restored: restored.counts,
        released: true,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '恢复执行失败';
      return await this.failAfterWrite(
        input.restoreId,
        run,
        protection,
        installation,
        now,
        'RESTORE_EXECUTION_FAILED',
        reason,
        input.actorAccountId,
      );
    } finally {
      // 执行权必须释放（否则同一次恢复再也执行不了）；
      // 进程崩溃时锁由数据库自动释放 ⇒ 中断后仍可重新执行收口。
      await executionLock?.release();
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
  ): Promise<LocalRestoreExecutionOutcome> {
    const rollback = await this.rollbackToProtection(run, protection, installation.installationId);
    if (!rollback.ok) {
      return await this.failAndKeepHold(
        restoreId,
        reasonCode,
        `${reason}（按保护副本回滚失败：${rollback.reason ?? '原因不可用'}）`,
        {
          actorAccountId,
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
          organizationId: run.organizationId,
          backupId: run.backupId,
          protectionBackupId: run.protectionBackupId ?? null,
          stage: LOCAL_RESTORE_AUDIT_STAGES.EXECUTION_HOLD_RETAINED,
        },
      );
    }
    await this.restoreRunRepository.update(
      { restoreId },
      {
        status: 'FAILED',
        finishedAt: now,
        // 库级 CHECK `chk_backup_restore_run_check_outcome`：
        // 终态 FAILED／INTERRUPTED 的行不得带核对结论
        checkStatus: null,
      },
    );
    // 失败终态事件是**尽力而为**：写不进去不能再反过来打断失败处置
    // （此时数据已回滚、冻结已解除，事件缺失只影响任务 10 的可读性）。
    await this.appendRestoreEvent({
      restoreId,
      actorAccountId,
      organizationId: run.organizationId,
      backupId: run.backupId,
      protectionBackupId: run.protectionBackupId ?? null,
      result: 'FAILED',
      stage: LOCAL_RESTORE_AUDIT_STAGES.EXECUTION_ROLLED_BACK,
      reasonCode,
    }).catch(() => undefined);
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
    organizationId: number;
    backupId: string;
    protectionBackupId: string | null;
    result: 'SUCCEEDED' | 'FAILED';
    stage: LocalRestoreAuditStage;
    reasonCode?: string | null;
    counts?: { records: number; originals: number; queue: number };
  }): Promise<void> {
    await this.managementAuditService.appendRestoreEvent({
      actorAccountId: input.actorAccountId,
      actorAdminLevel: 1,
      organizationId: input.organizationId,
      operation: 'RESTORE_LOCAL_BUSINESS',
      restoreId: input.restoreId,
      backupId: input.backupId,
      protectionBackupId: input.protectionBackupId,
      result: input.result,
      stage: input.stage,
      reasonCode: input.reasonCode ?? null,
      counts: input.counts,
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
        return {
          ok: false,
          reason: `核验失败：${table} 实际 ${actual} 行与清单 ${expected} 行不一致`,
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
      readonly organizationId: number;
      readonly backupId: string;
      readonly protectionBackupId: string | null;
      readonly stage: LocalRestoreAuditStage;
    },
  ): Promise<LocalRestoreExecutionOutcome> {
    await this.restoreRunRepository.update(
      { restoreId },
      {
        status: 'FAILED',
        finishedAt: new Date(),
        // 库级 CHECK `chk_backup_restore_run_check_outcome` 规定：
        // 终态 FAILED／INTERRUPTED 的行**不得**带核对结论（`check_status` 必须为空）。
        // （此前只写 status/finished_at ⇒ 失败路径在真实库上必然违反 CHECK，
        //   "失败保持冻结"这条语义根本落不了库。）
        checkStatus: null,
      },
    );
    if (audit !== undefined) {
      // 终态事件**尽力而为**：写不进去不改变"保持冻结"的结论（设备仍停写停传）。
      await this.appendRestoreEvent({
        restoreId,
        actorAccountId: audit.actorAccountId,
        organizationId: audit.organizationId,
        backupId: audit.backupId,
        protectionBackupId: audit.protectionBackupId,
        result: 'FAILED',
        stage: audit.stage,
        reasonCode,
      }).catch(() => undefined);
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
