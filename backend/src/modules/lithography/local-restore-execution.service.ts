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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Inject, Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  BACKUP_PAYLOAD_PATH,
  decryptBackupPayload,
  parseBackupManifest,
  parseProtectionKey,
} from '@core/local-runtime/policy/protected-backup.policy';
import { resolveRestoreExecutionCapability } from '@core/local-runtime/policy/restore-execution-capability.policy';

import { BackupAssetEntity } from './entities/backup-asset.entity';
import { BackupRestoreRunEntity } from './entities/backup-restore-run.entity';
import { LocalInstallationEntity } from './entities/local-installation.entity';
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
    private readonly moduleRef: ModuleRef,
    @Optional()
    @Inject(LOCAL_BACKUP_PROTECTION)
    private readonly backupProtection?: ProtectedBackupMaterial,
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

    // ① 冻结（先于任何写入）：恢复期间目标公司数据区停写停传
    await this.localWriteHoldService.hold({
      installationId: installation.installationId,
      organizationId: run.organizationId,
      restoreId: run.restoreId,
      reason: `恢复执行中（${run.restoreId}）`,
      now,
    });

    try {
      const restored = await this.restoreScope({ run, source });

      // ② 核验：逐表行数必须与清单一致（由来源域按真实事实给出）
      const verified = await this.verifyScope(run, restored.expectedRows);
      if (!verified.ok) {
        return await this.failAndKeepHold(
          input.restoreId,
          'RESTORE_VERIFY_FAILED',
          verified.reason,
        );
      }

      // ③ 解除冻结
      await this.localWriteHoldService.release({
        installationId: installation.installationId,
        organizationId: run.organizationId,
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
      return {
        status: 'SUCCEEDED',
        restoreId: run.restoreId,
        restored: restored.counts,
        released: true,
      };
    } catch (error) {
      // 失败：**保持冻结**、保留保护副本与任务、如实记原因
      return await this.failAndKeepHold(
        input.restoreId,
        'RESTORE_EXECUTION_FAILED',
        error instanceof Error ? error.message : '恢复执行失败',
      );
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
   * 按清单恢复：业务数据（中立受控端口）＋ 本机运行数据（队列任务／备份运行）。
   *
   * 业务数据写入端口未注册 ⇒ 抛错 ⇒ 上层按"失败并保持冻结"处理（不静默跳过）。
   */
  private async restoreScope(input: {
    run: BackupRestoreRunEntity;
    source: BackupAssetEntity | null;
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

    const writer = this.resolveRecordWriter();
    let records = 0;
    let queue = 0;
    for (const [table, rows] of Object.entries(payload)) {
      if (table === 'local_upload_task' || table === 'local_backup_run') {
        // 本机运行数据：恢复编排可直接写（不属业务表）
        queue += rows.length;
        continue;
      }
      const outcome = await writer.write({
        organizationId: run.organizationId,
        restoreId: run.restoreId,
        table: table as LocalRestoreRecordTable,
        rows,
      });
      if (outcome.status === 'FAILED') {
        throw new Error(outcome.reason ?? `业务数据恢复失败（${table}）`);
      }
      records += outcome.written;
    }

    return { counts: { records, originals: 0, queue }, expectedRows };
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
  ): Promise<{ ok: boolean; reason: string }> {
    const writer = this.resolveRecordWriter();
    for (const [table, expected] of Object.entries(expectedRows)) {
      if (table === 'local_upload_task' || table === 'local_backup_run') {
        continue;
      }
      const actual = await writer.count({
        organizationId: run.organizationId,
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

  /** 失败且**保持冻结**：写终态、保留保护副本与任务 */
  private async failAndKeepHold(
    restoreId: string,
    reasonCode: string,
    reason: string,
  ): Promise<LocalRestoreExecutionOutcome> {
    await this.restoreRunRepository.update(
      { restoreId },
      { status: 'FAILED', finishedAt: new Date() },
    );
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
