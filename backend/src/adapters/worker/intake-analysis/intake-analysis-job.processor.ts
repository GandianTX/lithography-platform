// src/adapters/worker/intake-analysis/intake-analysis-job.processor.ts

import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { IntakeAnalysisWorkerActivationUsecase } from '@src/usecases/intake-analysis/intake-analysis-worker-activation.usecase';
import { isIntakeAnalysisNonRetryableError } from '@src/usecases/intake-analysis/intake-analysis-worker.errors';
import { UnrecoverableError } from 'bullmq';
import { IntakeAnalysisJobHandler } from './intake-analysis-job.handler';
import {
  INTAKE_ANALYSIS_ADAPTER_QUEUE_NAME,
  type IntakeAnalysisFailedJob,
  type IntakeAnalysisJob,
  type IntakeAnalysisJobResultView,
} from './intake-analysis-job.mapper';

@Injectable()
@Processor(INTAKE_ANALYSIS_ADAPTER_QUEUE_NAME, { autorun: false })
export class IntakeAnalysisJobProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(IntakeAnalysisJobProcessor.name);

  constructor(
    private readonly handler: IntakeAnalysisJobHandler,
    private readonly workerActivation: IntakeAnalysisWorkerActivationUsecase,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    if (!this.workerActivation.shouldRun()) return;
    void this.worker.run().catch((error: unknown) => {
      this.logger.error(
        'Intake analysis BullMQ Worker stopped unexpectedly',
        error instanceof Error ? error.stack : undefined,
      );
    });
  }

  async process(job: IntakeAnalysisJob): Promise<IntakeAnalysisJobResultView> {
    try {
      return await this.handler.process({ job });
    } catch (error: unknown) {
      if (isIntakeAnalysisNonRetryableError(error)) throw new UnrecoverableError(error.message);
      throw error;
    }
  }

  @OnWorkerEvent('completed')
  async onCompleted(job: IntakeAnalysisJob): Promise<void> {
    await this.handler.onCompleted({ job });
  }

  @OnWorkerEvent('failed')
  async onFailed(job: IntakeAnalysisFailedJob | undefined, error: Error): Promise<void> {
    await this.handler.onFailed({ job, error });
  }
}
