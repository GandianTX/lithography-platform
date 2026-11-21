// src/usecases/repair-request/deliver-intake-analysis.usecase.ts
// 首析投递用例（报修域）：提交/重试事务提交后，把已登记账本的执行意图投递到 BullMQ。
//
// 可靠投递边界：
// - 账本行（base_async_task_record，queueName=intake-analysis，确定性 jobId）
//   已在调用方事务内写入 —— 回滚与提交/重试整体同命运；
// - 本用例只在事务外执行真正的 BullMQ add；失败或能力被禁用不视为业务失败，
//   账本行保持 queued，由 housekeeping 凭账本行补投（崩溃恢复路径）；
// - 同一 (intakeId, generationNo) 的重复投递由确定性 jobId 幂等吸收，
//   不会产生重复执行意图。

import { Injectable, Logger } from '@nestjs/common';
import {
  buildIntakeAnalysisJobId,
  INTAKE_ANALYSIS_JOB_NAME,
  INTAKE_ANALYSIS_QUEUE_NAME,
} from '@core/common/async-task/intake-analysis-job-id.policy';
import { IntakeAnalysisQueueService } from '@src/modules/lithography/queue/intake-analysis-queue.service';
import type {
  DeliverIntakeAnalysisInput,
  DeliverIntakeAnalysisResult,
} from './deliver-intake-analysis.types';

@Injectable()
export class DeliverIntakeAnalysisUsecase {
  private readonly logger = new Logger(DeliverIntakeAnalysisUsecase.name);

  constructor(private readonly intakeAnalysisQueueService: IntakeAnalysisQueueService) {}

  async execute(input: DeliverIntakeAnalysisInput): Promise<DeliverIntakeAnalysisResult> {
    const jobId = buildIntakeAnalysisJobId({
      intakeId: input.intakeId,
      generationNo: input.generationNo,
    });
    try {
      const enqueued = await this.intakeAnalysisQueueService.enqueueIntakeAnalysis({
        intakeId: input.intakeId,
        generationNo: input.generationNo,
        traceId: input.traceId,
      });
      return { delivered: true, jobId: enqueued.jobId, traceId: enqueued.traceId };
    } catch (error: unknown) {
      // 不上抛：提交/重试已成功（工单已出、账本行已落库），投递失败走崩溃恢复
      this.logger.error(
        `intake analysis delivery deferred to housekeeping: ${INTAKE_ANALYSIS_QUEUE_NAME}/${INTAKE_ANALYSIS_JOB_NAME} ${jobId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return { delivered: false, jobId, traceId: input.traceId };
    }
  }
}
