// src/adapters/worker/intake-analysis/intake-analysis-housekeeping.runner.ts
// 首析 housekeeping 运行时触发（任务 03 第二段）。
//
// 受控启停：与 IntakeAnalysisJobProcessor 同一激活门槛 —— 只有
// capability effectiveState === 'enabled' 才启动循环；运行中能力被关闭时，
// 当前轮完成后停止循环（backlog 保持未认领、可恢复，符合 capability 规则的
// quiet state 语义；恢复启用需进程重启后的 bootstrap）。
//
// 执行纪律：
// - 单飞：上一轮未结束不进入下一轮（setTimeout 链式调度 + inFlight 守卫）；
// - 失败可观察：逐轮 try/catch 记录错误日志，循环不因单轮失败中断；
// - 安全退出：onModuleDestroy 清除计时器并在宽限时间内等待在途执行结束。

import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { RunIntakeAnalysisHousekeepingUsecase } from '@src/usecases/intake-analysis/run-intake-analysis-housekeeping.usecase';
import { IntakeAnalysisWorkerActivationUsecase } from '@src/usecases/intake-analysis/intake-analysis-worker-activation.usecase';

/** 相邻两轮 housekeeping 的间隔（仅约束空转节奏；单轮内部按 batch 上限推进） */
export const INTAKE_ANALYSIS_HOUSEKEEPING_INTERVAL_MS = 60_000;

/** 停止时等待在途执行的宽限时间 */
export const INTAKE_ANALYSIS_HOUSEKEEPING_STOP_GRACE_MS = 10_000;

@Injectable()
export class IntakeAnalysisHousekeepingRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(IntakeAnalysisHousekeepingRunner.name);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly housekeeping: RunIntakeAnalysisHousekeepingUsecase,
    private readonly workerActivation: IntakeAnalysisWorkerActivationUsecase,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.workerActivation.shouldRun()) {
      this.logger.warn(
        'Intake analysis housekeeping stays quiet at bootstrap (capability not enabled)',
      );
      return;
    }
    this.scheduleNextTick(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const inFlight = this.inFlight;
    if (!inFlight) {
      return;
    }
    await Promise.race([
      inFlight.catch(() => undefined),
      new Promise<void>((resolve) => {
        setTimeout(resolve, INTAKE_ANALYSIS_HOUSEKEEPING_STOP_GRACE_MS);
      }),
    ]);
  }

  private scheduleNextTick(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    const timer = setTimeout(() => {
      void this.runTick();
    }, delayMs);
    timer.unref?.();
    this.timer = timer;
  }

  private async runTick(): Promise<void> {
    this.timer = null;
    if (this.stopped) {
      return;
    }
    if (this.inFlight) {
      // 防御性防重叠：链式调度下不应出现，出现则顺延一轮
      this.scheduleNextTick(INTAKE_ANALYSIS_HOUSEKEEPING_INTERVAL_MS);
      return;
    }
    if (!this.workerActivation.shouldRun()) {
      this.logger.warn(
        'Intake analysis housekeeping stopped (capability no longer enabled); backlog stays unclaimed and recoverable',
      );
      return;
    }
    const run = (async () => {
      try {
        const result = await this.housekeeping.execute();
        this.logger.log(
          {
            redeliverStaleQueued: result.redeliverStaleQueued,
            recoverStaleProcessing: result.recoverStaleProcessing,
            cancelOrphanedIntents: result.cancelOrphanedIntents,
          },
          'Intake analysis housekeeping tick finished',
        );
      } catch (error: unknown) {
        this.logger.error(
          'Intake analysis housekeeping tick failed',
          error instanceof Error ? error.stack : String(error),
        );
      }
    })();
    this.inFlight = run;
    try {
      await run;
    } finally {
      this.inFlight = null;
      if (!this.stopped) {
        this.scheduleNextTick(INTAKE_ANALYSIS_HOUSEKEEPING_INTERVAL_MS);
      }
    }
  }
}
