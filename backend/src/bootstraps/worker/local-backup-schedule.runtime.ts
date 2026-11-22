// src/bootstraps/worker/local-backup-schedule.runtime.ts

import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { BACKUP_UPLOAD_DETECT_INTERVAL_MINUTES } from '@core/local-runtime/policy/local-backup-upload.policy';
import { BackupScheduleService } from '@src/modules/lithography/backup-schedule.service';
import { LocalBackupCleanupService } from '@src/modules/lithography/local-backup-cleanup.service';
import { LocalBackupUploadService } from '@src/modules/lithography/local-backup-upload.service';

/**
 * 本地备份计划运行时（任务 09 S3.1，D-8：Worker 引导内定时扫描）。
 * - 不依赖页面登录：随 Worker 常驻，按固定周期（5 分钟）扫描 72h 持久计划；
 * - 启动时先执行一轮（重启补偿：RUNNING 残留改判 INTERRUPTED 并补一次）；
 * - 同一轮内接着执行自动上云重试扫描（S3.2）：退避判定在 core 策略，
 *   重试锚点是既有备份资产，不会重新生成备份包；
 * - 过期清理（S3.3）按每日一次节奏检查：约 30 天保留窗口到期的本地包逐项清理
 *   （云端副本不是清理门槛，云副本保留不删）；
 * - 扫描异常只记日志不中断进程（下一轮重试）。
 */
@Injectable()
export class LocalBackupScheduleRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** 过期清理每日一次的当日标记（本地日期） */
  private retentionCheckDay: string | null = null;

  constructor(
    private readonly backupScheduleService: BackupScheduleService,
    private readonly backupUploadService: LocalBackupUploadService,
    private readonly backupCleanupService: LocalBackupCleanupService,
    private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    void this.runCycle();
    // 检测周期取**策略层常量**（不再另写一份 5 分钟，避免口径漂移）
    this.timer = setInterval(
      () => void this.runCycle(),
      BACKUP_UPLOAD_DETECT_INTERVAL_MINUTES * 60_000,
    );
    this.logger.log('local backup schedule runtime started (interval=5min)');
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async runCycle(): Promise<void> {
    if (this.running) {
      return; // 上一轮未结束：跳过本轮，避免并发扫描
    }
    this.running = true;
    try {
      const result = await this.backupScheduleService.runOnce();
      if (result.triggered > 0 || result.compensated > 0 || result.initialized > 0) {
        this.logger.log(
          `local backup cycle: compensated=${result.compensated} initialized=${result.initialized} succeeded=${result.succeeded} failed=${result.failed} skipped=${result.skipped}`,
        );
      }
      const upload = await this.backupUploadService.runOnce();
      if (upload.attempted > 0 || upload.compensated > 0 || upload.receiverMissing > 0) {
        this.logger.log(
          `local backup upload cycle: attempted=${upload.attempted} succeeded=${upload.succeeded} failed=${upload.failed} waiting=${upload.waiting} skipped=${upload.skipped} compensated=${upload.compensated} receiverMissing=${upload.receiverMissing}`,
        );
      }
      await this.runRetentionCheck();
    } catch (error) {
      this.logger.error(
        `local backup cycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * 过期清理检查：每日一次（需求口径「每日及恢复运行检查」）。
   *
   * 只清理保留窗口已到期的本地包；失败项保留在本机并记录原因。
   */
  private async runRetentionCheck(): Promise<void> {
    const today = localDateKey(new Date());
    if (this.retentionCheckDay === today) {
      return;
    }
    this.retentionCheckDay = today;

    const result = await this.backupCleanupService.cleanupAllExpiredPackages();
    if (result.targetCount > 0 || result.cleaned > 0) {
      this.logger.log(
        `local backup retention cycle: targets=${result.targetCount} cleaned=${result.cleaned} retained=${result.retained}`,
      );
    }

    // 孤儿包巡检（review M8 重启补偿）：回收进程被杀留下的半成品包目录
    const orphan = await this.backupCleanupService.sweepOrphanPackages();
    if (orphan.removed > 0) {
      this.logger.log(
        `local backup orphan sweep: scanned=${orphan.scanned} removed=${orphan.removed}`,
      );
    }
  }
}

/**
 * 本地日期键（YYYY-MM-DD）。
 *
 * 「每日一次」判定必须按**本地日期**：用 UTC 日期会在本地时区跨日的时段把
 * 两次清理挤到同一天、或在同一天里跳过一轮（UTC 与本地相差 8 小时时尤其明显）。
 */
export function localDateKey(at: Date): string {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, '0');
  const day = `${at.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}
