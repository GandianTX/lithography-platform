// src/adapters/worker/intake-analysis/intake-analysis-job.handler.ts
// 运行时钩子 → 单一职责 usecase 入口；不跨阶段编排、不按业务结果分叉。

import { Injectable } from '@nestjs/common';
import { ConsumeIntakeAnalysisJobUsecase } from '@src/usecases/intake-analysis/consume-intake-analysis-job.usecase';
import type { ConsumeIntakeAnalysisJobProcessResult } from '@src/usecases/intake-analysis/intake-analysis-worker.types';
import {
  mapIntakeAnalysisJobToCompleteInput,
  mapIntakeAnalysisJobToFailInput,
  mapIntakeAnalysisJobToProcessInput,
  mapMissingIntakeAnalysisJobToFailInput,
  type IntakeAnalysisFailedJob,
  type IntakeAnalysisJob,
} from './intake-analysis-job.mapper';

@Injectable()
export class IntakeAnalysisJobHandler {
  constructor(private readonly consumeUsecase: ConsumeIntakeAnalysisJobUsecase) {}

  async process(input: {
    readonly job: IntakeAnalysisJob;
  }): Promise<ConsumeIntakeAnalysisJobProcessResult> {
    return await this.consumeUsecase.process(
      mapIntakeAnalysisJobToProcessInput({ job: input.job }),
    );
  }

  async onCompleted(input: { readonly job: IntakeAnalysisJob }): Promise<void> {
    await this.consumeUsecase.complete(mapIntakeAnalysisJobToCompleteInput({ job: input.job }));
  }

  async onFailed(input: {
    readonly job: IntakeAnalysisFailedJob | undefined;
    readonly error: Error;
  }): Promise<void> {
    if (!input.job) {
      // 降级上下文：job 缺失也必须先落审计失败记录，不得直接 return
      await this.consumeUsecase.fail(
        mapMissingIntakeAnalysisJobToFailInput({ error: input.error }),
      );
      return;
    }
    await this.consumeUsecase.fail(
      mapIntakeAnalysisJobToFailInput({
        job: input.job as unknown as IntakeAnalysisJob,
        error: input.error,
      }),
    );
  }
}
