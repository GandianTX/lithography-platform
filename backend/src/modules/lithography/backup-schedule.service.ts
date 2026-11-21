// src/modules/lithography/backup-schedule.service.ts

import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';

import { LocalAccountAuthorizationEntity } from '@src/modules/lithography/entities/local-account-authorization.entity';
import { LocalCompanySettingEntity } from '@src/modules/lithography/entities/local-company-setting.entity';
import { LocalBackupRunEntity } from '@src/modules/lithography/entities/local-backup-run.entity';
import { LocalInstallationEntity } from '@src/modules/lithography/entities/local-installation.entity';
import { ProtectedBackupService } from '@src/modules/lithography/protected-backup.service';

/**
 * 72h 持久计划执行器（任务 09 S3.1，D-8：Worker 引导内定时扫描，不依赖页面登录）。
 *
 * 单次扫描（runOnce）三步，全部幂等、可重复执行：
 * 1. 恢复运行补偿：进程重启后残留的 RUNNING（超过补偿时限未结束）改判 INTERRUPTED，
 *    计划随后按"补一次"语义重新触发；
 * 2. 计划初始化（D-11 属 S3 落地）：对无当前计划的公司按默认 72h 建行，
 *    backup_enabled 默认关闭（R078 云与计划不因迁移自动开启）；
 * 3. 到期触发：backup_enabled=1 且 next_backup_at 到期的计划逐个执行：
 *    建 RUNNING（同公司互斥，冲突本轮跳过）→ 生成受保护包 → 结束运行并推进 next_backup_at；
 *    失败也推进 next_backup_at（下轮补一次），失败原因落计划行。
 */
@Injectable()
export class BackupScheduleService {
  /** RUNNING 运行超过该时长视为中断残留（默认 60 分钟） */
  private readonly compensationMinutes = 60;

  constructor(
    @InjectRepository(LocalCompanySettingEntity)
    private readonly settingRepository: Repository<LocalCompanySettingEntity>,
    @InjectRepository(LocalAccountAuthorizationEntity)
    private readonly authorizationRepository: Repository<LocalAccountAuthorizationEntity>,
    @InjectRepository(LocalBackupRunEntity)
    private readonly backupRunRepository: Repository<LocalBackupRunEntity>,
    @InjectRepository(LocalInstallationEntity)
    private readonly installationRepository: Repository<LocalInstallationEntity>,
    private readonly protectedBackupService: ProtectedBackupService,
    @Optional() private readonly onCycleLog?: (message: string) => void,
  ) {}

  /** 执行一轮调度扫描（Worker 定时调用；亦可由内部入口手动触发） */
  async runOnce(now: Date = new Date()): Promise<{
    compensated: number;
    initialized: number;
    triggered: number;
    succeeded: number;
    failed: number;
    skipped: number;
  }> {
    const compensated = await this.compensateInterruptedRuns(now);
    const initialized = await this.initializeMissingPlans();
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    const due = await this.settingRepository.find({
      where: { backupEnabled: true, nextBackupAt: LessThanOrEqual(now) },
    });
    for (const plan of due) {
      const result = await this.runDuePlan(plan, now);
      if (result === 'succeeded') {
        succeeded += 1;
      } else if (result === 'failed') {
        failed += 1;
      } else {
        skipped += 1; // 同公司已有 RUNNING，互斥跳过
      }
    }
    const triggered = succeeded + failed;
    return { compensated, initialized, triggered, succeeded, failed, skipped };
  }

  /** RUNNING 残留补偿：改判 INTERRUPTED（计划随后补一次） */
  private async compensateInterruptedRuns(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.compensationMinutes * 60_000);
    const stale = await this.backupRunRepository.find({
      where: { status: 'RUNNING' },
    });
    let compensated = 0;
    for (const run of stale) {
      if (run.startedAt.getTime() > cutoff.getTime()) {
        continue; // 仍在补偿时限内，可能是正在执行的备份
      }
      await this.backupRunRepository.update(
        { id: run.id },
        {
          status: 'INTERRUPTED',
          finishedAt: now,
          errorCode: 'BACKUP_INTERRUPTED_BY_RESTART',
          errorMessage: '进程重启导致备份运行中断，计划将补一次',
        },
      );
      compensated += 1;
    }
    return compensated;
  }

  /**
   * 计划初始化（D-11 属 S3 落地）：对"有活跃同步授权或已有计划行"的公司补齐当前计划行。
   * 计划默认 72h、backup_enabled 默认关闭（R078：不因初始化自动开启）；
   * 公司来源取授权/映射事实，不凭空造公司。
   */
  private async initializeMissingPlans(): Promise<number> {
    const installation = await this.installationRepository.findOne({ where: { id: 1 } });
    if (!installation) {
      return 0;
    }
    const existingPlans = await this.settingRepository.find({
      where: { installationId: installation.installationId, isCurrent: true },
    });
    const covered = existingPlans.map((setting) => setting.organizationId);
    const authorized = await this.authorizationRepository.find({
      where: { authorizationStatus: 'ACTIVE' },
    });
    const organizationIds: number[] = [];
    for (const authorization of authorized) {
      const organizationId = authorization.organizationId;
      if (
        organizationId !== null &&
        !covered.includes(organizationId) &&
        !organizationIds.includes(organizationId)
      ) {
        organizationIds.push(organizationId);
      }
    }
    let initialized = 0;
    for (const organizationId of organizationIds) {
      await this.settingRepository.save(
        this.settingRepository.create({
          installationId: installation.installationId,
          organizationId,
          settingSource: 'LOCAL_MANUAL',
          isCurrent: true,
          backupIntervalHours: 72,
          backupEnabled: false,
          autoUploadEnabled: false,
        }),
      );
      initialized += 1;
    }
    return initialized;
  }

  /** 执行一个到期计划：建运行→生成包→结束推进；skipped 表示同公司互斥跳过 */
  private async runDuePlan(
    plan: LocalCompanySettingEntity,
    now: Date,
  ): Promise<'succeeded' | 'failed' | 'skipped'> {
    const existing = await this.backupRunRepository.findOne({
      where: { organizationId: plan.organizationId, status: 'RUNNING' },
    });
    if (existing) {
      // 同公司已有 RUNNING（上一轮遗留未到补偿时限）：本轮跳过，不改计划
      return 'skipped';
    }
    const run = await this.backupRunRepository.save(
      this.backupRunRepository.create({
        installationId: plan.installationId,
        organizationId: plan.organizationId,
        triggerType: 'SCHEDULED',
        status: 'RUNNING',
        startedAt: now,
        finishedAt: null,
        manifestPath: null,
        manifestChecksum: null,
        byteSize: null,
        attachmentCount: null,
        schemaVersion: null,
        errorCode: null,
        errorMessage: null,
      }),
    );
    const targetPath = this.protectedBackupService.resolvePackageTargetPath(
      plan.organizationId,
      'SCHEDULED',
      now,
    );
    try {
      const result = await this.protectedBackupService.generateProtectedBackup({
        organizationId: plan.organizationId,
        runId: run.id,
        targetPath,
      });
      await this.backupRunRepository.update(
        { id: run.id },
        {
          status: 'SUCCEEDED',
          finishedAt: new Date(),
          manifestPath: result.packagePath,
          manifestChecksum: result.manifestChecksum,
          byteSize: result.byteSize,
        },
      );
      await this.settingRepository.update(
        { id: plan.id },
        {
          nextBackupAt: this.nextBackupAt(plan, now),
          lastAutoSuccessAt: new Date(),
          failureReason: null,
        },
      );
      this.onCycleLog?.(
        `backup succeeded: organization=${plan.organizationId} backupId=${result.backupId}`,
      );
      return 'succeeded';
    } catch (error) {
      const message = error instanceof Error ? error.message : '备份生成失败';
      await this.backupRunRepository.update(
        { id: run.id },
        {
          status: 'FAILED',
          finishedAt: new Date(),
          errorCode: 'BACKUP_GENERATION_FAILED',
          errorMessage: message,
        },
      );
      await this.settingRepository.update(
        { id: plan.id },
        {
          nextBackupAt: this.nextBackupAt(plan, now),
          lastAutoFailureAt: new Date(),
          failureReason: message,
        },
      );
      this.onCycleLog?.(`backup failed: organization=${plan.organizationId} reason=${message}`);
      return 'failed';
    }
  }

  /** 计划推进：当前时间＋间隔小时（失败同样推进，下轮补一次） */
  private nextBackupAt(plan: LocalCompanySettingEntity, now: Date): Date {
    const intervalHours = Number(plan.backupIntervalHours) || 72;
    return new Date(now.getTime() + intervalHours * 3_600_000);
  }
}

// nodePath 在顶部统一引入
