// src/bootstraps/worker/local-backup-schedule.runtime.ts

import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { BackupScheduleService } from '@src/modules/lithography/backup-schedule.service';
import { LocalBackupUploadService } from '@src/modules/lithography/local-backup-upload.service';

/**
 * 本地备份计划运行时（任务 09 S3.1，D-8：Worker 引导内定时扫描）。
 * - 不依赖页面登录：随 Worker 常驻，按固定周期（5 分钟）扫描 72h 持久计划；
 * - 启动时先执行一轮（重启补偿：RUNNING 残留改判 INTERRUPTED 并补一次）；
 * - 同一轮内接着执行自动上云重试扫描（S3.2）：退避判定在 core 策略，
 *   重试锚点是既有备份资产，不会重新生成备份包；
 * - 扫描异常只记日志不中断进程（下一轮重试）。
 */
@Injectable()
export class LocalBackupScheduleRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly backupScheduleService: BackupScheduleService,
    private readonly backupUploadService: LocalBackupUploadService,
    private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    void this.runCycle();
    this.timer = setInterval(() => void this.runCycle(), 5 * 60_000);
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
    } catch (error) {
      this.logger.error(
        `local backup cycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
