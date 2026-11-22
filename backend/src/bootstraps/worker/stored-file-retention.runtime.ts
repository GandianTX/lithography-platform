// src/bootstraps/worker/stored-file-retention.runtime.ts

/**
 * 过期暂存原件清理运行时（任务 09 P3-3 跨资源失败补偿）。
 *
 * 与既有后台任务同一范式（照 `local-backup-schedule.runtime.ts`）：
 * - 随 Worker 常驻，不依赖页面登录；
 * - 启动时先跑一轮（重启补偿：上次中断留下的过期行下一轮继续处理）；
 * - **每日一次**的保留窗口检查（按**本地日期**判定，不用 UTC 日期）；
 * - 同一轮内单飞（上一轮未结束则跳过本轮，避免并发扫描）；
 * - 异常只记日志不中断进程（下一轮重试）。
 */

import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Logger } from 'nestjs-pino';

import { CleanupExpiredStoredFilesUsecase } from '@usecases/stored-file/cleanup-expired-stored-files.usecase';

import { localDateKey } from './local-backup-schedule.runtime';

@Injectable()
export class StoredFileRetentionRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** 保留窗口检查每日一次的当日标记（本地日期） */
  private retentionCheckDay: string | null = null;

  constructor(
    private readonly cleanupExpiredStoredFilesUsecase: CleanupExpiredStoredFilesUsecase,
    private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    void this.runCycle();
    this.timer = setInterval(
      () => void this.runCycle(),
      60 * 60_000, // 每小时唤醒一次；实际清理按每日一次判定
    );
    this.logger.log('stored file retention runtime started (interval=1h, retention=daily)');
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
      await this.runRetentionCheck();
    } catch (error) {
      this.logger.error(
        `stored file retention cycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * 保留窗口检查：每日一次。
   *
   * 只清理"到期且未被任何业务引用"的暂存行；保留项逐条记原因，
   * 失败项保留事实、下一轮重试。
   */
  private async runRetentionCheck(): Promise<void> {
    const today = localDateKey(new Date());
    if (this.retentionCheckDay === today) {
      return;
    }
    this.retentionCheckDay = today;

    const result = await this.cleanupExpiredStoredFilesUsecase.execute();
    if (result.targetCount > 0 || result.cleaned > 0) {
      this.logger.log(
        `stored file retention cycle: targets=${result.targetCount} cleaned=${result.cleaned} retained=${result.retained} failed=${result.failed}`,
      );
    }
  }
}
