// src/bootstraps/worker/local-business-sync.runtime.ts
import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Logger } from 'nestjs-pino';

import { ReconcileBusinessSyncTasksUsecase } from '@src/usecases/local-runtime/reconcile-business-sync-tasks.usecase';

/**
 * 本机业务同步运行时（任务 09 S2.1）。
 *
 * - 不依赖页面登录：随 Worker 常驻，按固定周期（5 分钟）对齐「来源记录 ↔ 待传任务」；
 * - 启动时先执行一轮（重启补偿：本机重启后未派发的待办继续对齐）；
 * - 同一轮内并发保护：上一轮未结束则跳过本轮；
 * - 扫描异常只记日志不中断进程（下一轮重试）。
 */
@Injectable()
export class LocalBusinessSyncRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly reconcileBusinessSyncTasksUsecase: ReconcileBusinessSyncTasksUsecase,
    private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    void this.runCycle();
    this.timer = setInterval(() => void this.runCycle(), 5 * 60_000);
    this.logger.log('local business sync runtime started (interval=5min)');
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
      const result = await this.reconcileBusinessSyncTasksUsecase.execute();
      if (result.created > 0 || result.cancelled > 0 || result.rejected > 0) {
        this.logger.log(
          `local business sync cycle: scanned=${result.scanned} created=${result.created} existing=${result.existing} cancelled=${result.cancelled} rejected=${result.rejected}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `local business sync cycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
