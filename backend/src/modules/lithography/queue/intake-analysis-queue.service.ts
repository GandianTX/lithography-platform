// src/modules/lithography/queue/intake-analysis-queue.service.ts
// 首析投递队列服务（modules 层，任务 03 第二段）。
//
// 职责：
// - 提交/重试事务提交后把首析意图投递到 BullMQ `intake-analysis` 队列；
// - 状态感知补投：housekeeping 检查 BullMQ 中确定性 jobId 的运行时状态，
//   在途（waiting/active/delayed）不抢投；终态保留先移除再补投；不存在直接补投。
//
// 投递语义（明确区分两类补投）：
// - 基建补投：BullMQ attempts（瞬时故障）与 housekeeping 凭账本行补投（进程退出 /
//   投递失败），两者都不推进首析代次、不消耗用户的唯一主动重试机会；
// - 主动重试：仅本人且第 0 代失败后一次，代次 0→1 产生新确定性 jobId。
//
// 入队失败不上抛阻断业务：提交/重试本身已成功（工单已出、账本行已随事务落库），
// 失败只记日志，由 housekeeping 恢复。

import { Inject, Injectable } from '@nestjs/common';
import { CapabilityRuntimeContributionProvider } from '@src/infrastructure/capability/capability.decorators';
import { BULLMQ_JOBS, BULLMQ_QUEUES } from '@src/infrastructure/bullmq/bullmq.constants';
import {
  BullMqProducerGateway,
  type BullMqJobRuntimeState,
} from '@src/infrastructure/bullmq/producer.gateway';
import {
  CAPABILITY_STATE_READER,
  type CapabilityStateReader,
} from '@src/modules/common/capability-state-reader.contract';
import { buildIntakeAnalysisJobId } from '@core/common/async-task/intake-analysis-job-id.policy';
import { PinoLogger } from 'nestjs-pino';
import type {
  IntakeAnalysisQueueEnqueueInput,
  IntakeAnalysisQueueEnqueueResult,
  IntakeAnalysisRedeliverAction,
} from './intake-analysis-queue.types';

export const INTAKE_ANALYSIS_CAPABILITY_ID = 'intake.analysis' as const;

@Injectable()
@CapabilityRuntimeContributionProvider({
  capabilityId: INTAKE_ANALYSIS_CAPABILITY_ID,
  runtimeDependencies: [{ capabilityId: 'runtime.async-task', requirement: 'required' }],
  queueResources: [
    { queueName: BULLMQ_QUEUES.INTAKE_ANALYSIS, jobName: BULLMQ_JOBS.INTAKE_ANALYSIS.ANALYZE },
  ],
})
export class IntakeAnalysisQueueService {
  constructor(
    private readonly producer: BullMqProducerGateway,
    private readonly logger: PinoLogger,
    @Inject(CAPABILITY_STATE_READER)
    private readonly capabilityStateReader: CapabilityStateReader,
  ) {
    this.logger.setContext(IntakeAnalysisQueueService.name);
  }

  /**
   * 投递一次首析执行意图（显式确定性 jobId，BullMQ 同 jobId add 幂等）。
   * 调用前提：账本行已在调用方事务内登记（recordEnqueued）。
   */
  async enqueueIntakeAnalysis(
    input: IntakeAnalysisQueueEnqueueInput,
  ): Promise<IntakeAnalysisQueueEnqueueResult> {
    this.capabilityStateReader.requireEnabled(INTAKE_ANALYSIS_CAPABILITY_ID);
    const jobId = buildIntakeAnalysisJobId({
      intakeId: input.intakeId,
      generationNo: input.generationNo,
    });
    const job = await this.producer.enqueue({
      queueName: BULLMQ_QUEUES.INTAKE_ANALYSIS,
      jobName: BULLMQ_JOBS.INTAKE_ANALYSIS.ANALYZE,
      payload: {
        intakeId: input.intakeId,
        generationNo: input.generationNo,
        traceId: input.traceId,
      },
      explicitJobId: jobId,
      traceId: input.traceId,
    });
    this.logger.info(
      {
        intakeId: input.intakeId,
        generationNo: input.generationNo,
        jobId: job.jobId,
        traceId: job.traceId,
      },
      'Intake analysis job accepted',
    );
    return { jobId: job.jobId, traceId: job.traceId };
  }

  /**
   * 状态感知补投：只有 BullMQ 确认没有在途 job 时才产生真实投递。
   * - waiting/active/delayed → in_flight（含 BullMQ 重试退避，等待其自身生命周期）；
   * - completed/failed（终态保留）→ 先移除再补投；不移除的话，同 jobId 再次 add
   *   只会命中去重并返回旧 job，永远不会重新入队；
   * - unknown（job 不存在）→ 直接补投（崩溃恢复主路径）。
   * 真实恢复安全由认领侧状态机兜底（ALREADY_SUCCEEDED / ALREADY_FAILED / 代次匹配 / 租约），
   * 不依赖「补投成功」这一动作本身。
   *
   * TOCTOU 窗口（状态读取与移除之间）：终态（completed/failed）job 不会再回到
   * active，不会被误删在途执行；若外部操作（如人工 retryJobs）恰好在该窗口把
   * failed 移回 waiting，本方法可能移除一个刚回队 job——此时账本行仍在，
   * 下一轮 housekeeping 按 job_missing 重新补投，确定性 jobId 的 add 幂等与
   * 认领仲裁保证不产生第二次执行，窗口自愈。remove 返回 0（不存在或被锁定）
   * 时本轮放弃，不产生投递。
   */
  async redeliverIntakeAnalysis(
    input: IntakeAnalysisQueueEnqueueInput,
  ): Promise<IntakeAnalysisRedeliverAction> {
    this.capabilityStateReader.requireEnabled(INTAKE_ANALYSIS_CAPABILITY_ID);
    const jobId = buildIntakeAnalysisJobId({
      intakeId: input.intakeId,
      generationNo: input.generationNo,
    });
    const { state } = await this.producer.getJobState({
      queueName: BULLMQ_QUEUES.INTAKE_ANALYSIS,
      jobId,
    });
    if (state === 'waiting' || state === 'active' || state === 'delayed') {
      return { kind: 'in_flight' };
    }
    if (state === 'completed' || state === 'failed') {
      const { removed } = await this.producer.removeJob({
        queueName: BULLMQ_QUEUES.INTAKE_ANALYSIS,
        jobId,
      });
      if (!removed) {
        return { kind: 'skipped', reason: 'job_remove_failed' };
      }
      await this.enqueueIntakeAnalysis(input);
      return { kind: 'redelivered', basis: 'job_terminal_removed' };
    }
    await this.enqueueIntakeAnalysis(input);
    return { kind: 'redelivered', basis: 'job_missing' };
  }

  /** 查询确定性 jobId 的运行时状态（账本取消路径用于判断 job 是否仍在途） */
  async getIntakeAnalysisJobState(input: {
    readonly intakeId: number;
    readonly generationNo: number;
  }): Promise<BullMqJobRuntimeState> {
    this.capabilityStateReader.requireEnabled(INTAKE_ANALYSIS_CAPABILITY_ID);
    const jobId = buildIntakeAnalysisJobId({
      intakeId: input.intakeId,
      generationNo: input.generationNo,
    });
    const result = await this.producer.getJobState({
      queueName: BULLMQ_QUEUES.INTAKE_ANALYSIS,
      jobId,
    });
    return result.state;
  }

  async checkIntakeAnalysisQueueAvailable(): Promise<boolean> {
    this.capabilityStateReader.requireEnabled(INTAKE_ANALYSIS_CAPABILITY_ID);
    try {
      await this.producer.checkQueueAvailable({ queueName: BULLMQ_QUEUES.INTAKE_ANALYSIS });
      return true;
    } catch {
      return false;
    }
  }
}
