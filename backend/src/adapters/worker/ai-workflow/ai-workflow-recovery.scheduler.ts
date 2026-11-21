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

/** 单轮批量上限 */
export const AI_WORKFLOW_RECOVERY_BATCH_LIMIT = 50;

@Injectable()
export class AiWorkflowRecoveryScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  /**
   * 结算扫描的键集游标（上一批末键）。
   *
   * 满批时保留末键、下一轮从该键之后继续；读到最后一批时置空，下一轮从头回绕，
   * 从而重新覆盖此前被跳过（活动执行、非失败终态）与单条异常的候选。
   * 只在内存中维护：进程重启即从头扫，保证停机期间历史遗漏能被重新发现。
   */
  private settlementCursor: string | null = null;

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
        afterQuestionUuid: this.settlementCursor,
        limit: AI_WORKFLOW_RECOVERY_BATCH_LIMIT,
      });
      // 满批保留末键继续，到末尾置空并在下一轮从头回绕；读取失败时异常上抛，
      // 游标保持原值，不会跳到未处理的区间。
      this.settlementCursor = settlement.nextCursor;
      const admissionChanged =
        housekeeping.admission.succeeded > 0 || housekeeping.admission.failed > 0;
      if (admissionChanged || settlement.settled > 0 || settlement.failed > 0) {
        this.logger.info(
          {
            admission: housekeeping.admission,
            staleQueued: housekeeping.staleQueued,
            settlement,
          },
          'AI workflow 恢复扫描完成',
        );
      }
      if (!settlement.reachedEnd) {
        // 本批读满：候选还有后续，下一轮从末键之后继续。
        this.logger.debug(
          { scanned: settlement.scanned, nextCursor: settlement.nextCursor },
          '恢复扫描本批已满，下一轮从末键继续',
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
