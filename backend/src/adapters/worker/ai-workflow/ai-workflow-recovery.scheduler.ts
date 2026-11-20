// src/adapters/worker/ai-workflow/ai-workflow-recovery.scheduler.ts
// 任务05 S2.1-5／S2.1-6 纠偏：把 AI 工作流恢复编排接到正式 Worker 生命周期。
//
// 背景（2026-11-20 核验）：
// - 「受理后未投递」「准入过期」「执行终止但 analysis 未收敛」三类补偿此前由
//   状态查询在读路径上隐式触发，导致读权限隐含写入与投递能力；
// - `RunAiWorkflowHousekeepingUsecase` 有实现但没有生产调用者，恢复实际上不会运行。
//
// 本调度器是恢复的唯一正式入口，遵守以下边界：
// - 只在 Worker 进程、且能力 `ai.workflow` 为 enabled 时运行（复用 `CapabilityModule`
//   与既有激活判定，不新增调度框架）；
// - 启动后立即跑一轮，之后按固定间隔重跑；单飞（上一轮未结束不叠加）；
// - 停机时释放定时器，不再发起新的一轮；
// - 单轮失败只记日志，不抛出到进程级（下一轮会重试，写入均由条件更新兜底）；
// - 批量上限：housekeeping 与结算各自按 limit 截断，避免单轮长时间占用。

import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AiQuestionAnalysisSettlementService } from '@src/usecases/ai-conversation/ai-question-analysis-settlement.service';
import { RunAiWorkflowHousekeepingUsecase } from '@src/usecases/ai-workflow/run-ai-workflow-housekeeping.usecase';
import { AiWorkflowWorkerActivationUsecase } from '@src/usecases/ai-worker/ai-workflow-worker-activation.usecase';

/** 恢复扫描间隔（毫秒）。准入过期判定与重投都以该节奏推进。 */
export const AI_WORKFLOW_RECOVERY_INTERVAL_MS = 30_000;

/** 结算回看窗口（毫秒）：覆盖「执行终态落库」到「下一轮扫描」之间的间隔抖动。 */
export const AI_WORKFLOW_RECOVERY_LOOKBACK_MS = 10 * 60_000;

/** 单轮批量上限 */
export const AI_WORKFLOW_RECOVERY_BATCH_LIMIT = 50;

@Injectable()
export class AiWorkflowRecoveryScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly activation: AiWorkflowWorkerActivationUsecase,
    private readonly housekeeping: RunAiWorkflowHousekeepingUsecase,
    private readonly settlement: AiQuestionAnalysisSettlementService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AiWorkflowRecoveryScheduler.name);
  }

  onApplicationBootstrap(): void {
    if (!this.activation.shouldRun()) {
      this.logger.info('AI workflow 能力未启用，恢复调度不启动');
      return;
    }
    this.start();
  }

  onApplicationShutdown(): void {
    this.stop();
  }

  /** 启动一轮立即执行 + 周期执行（幂等：重复调用不会叠加定时器） */
  start(): void {
    if (this.timer !== null) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, AI_WORKFLOW_RECOVERY_INTERVAL_MS);
    // 不因定时器阻止进程退出；停机钩子仍会清理
    this.timer.unref?.();
    this.logger.info(
      {
        intervalMs: AI_WORKFLOW_RECOVERY_INTERVAL_MS,
        batchLimit: AI_WORKFLOW_RECOVERY_BATCH_LIMIT,
      },
      'AI workflow 恢复调度已启动',
    );
  }

  /** 释放定时器（幂等） */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    this.logger.info('AI workflow 恢复调度已停止');
  }

  /** 是否已启动（供单测与健康检查使用） */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * 单轮恢复：先做工作流侧（准入重投／准入超时／陈旧排队），
   * 再做业务侧（执行终止后的 analysis 补写）。
   *
   * 顺序固定：housekeeping 可能把待准入标记为失败，随后结算能在同一轮里
   * 把对应 analysis 收敛，避免多等一个扫描周期。
   */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.inFlight) {
      this.logger.debug('上一轮恢复仍在执行，本轮跳过');
      return;
    }
    this.inFlight = true;
    try {
      const housekeeping = await this.housekeeping.execute({
        now,
        limit: AI_WORKFLOW_RECOVERY_BATCH_LIMIT,
      });
      const settlement = await this.settlement.sweep({
        since: new Date(now.getTime() - AI_WORKFLOW_RECOVERY_LOOKBACK_MS),
        limit: AI_WORKFLOW_RECOVERY_BATCH_LIMIT,
      });
      const admissionChanged =
        housekeeping.admission.succeeded > 0 || housekeeping.admission.failed > 0;
      if (admissionChanged || settlement.settled > 0) {
        this.logger.info(
          {
            admission: housekeeping.admission,
            staleQueued: housekeeping.staleQueued,
            settlement,
          },
          'AI workflow 恢复扫描完成',
        );
      }
      // 单轮命中上限说明窗口内还有未处理项：本轮不做游标推进（写入幂等、下一轮会再取），
      // 但必须给出可观测信号，避免「看起来在跑、其实长期追不上」。
      if (settlement.scanned >= AI_WORKFLOW_RECOVERY_BATCH_LIMIT) {
        this.logger.warn(
          { scanned: settlement.scanned, batchLimit: AI_WORKFLOW_RECOVERY_BATCH_LIMIT },
          '恢复扫描达到批量上限，窗口内仍有未结算执行',
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        { error: error instanceof Error ? error.message.slice(0, 300) : 'recovery_error' },
        'AI workflow 恢复扫描失败，等待下一轮',
      );
    } finally {
      this.inFlight = false;
    }
  }
}
