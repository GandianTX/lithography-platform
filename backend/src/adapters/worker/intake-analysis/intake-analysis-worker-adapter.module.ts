// src/adapters/worker/intake-analysis/intake-analysis-worker-adapter.module.ts

import { Module } from '@nestjs/common';
import { IntakeAnalysisUsecasesModule } from '@src/usecases/intake-analysis/intake-analysis-usecases.module';
import { IntakeAnalysisHousekeepingRunner } from './intake-analysis-housekeeping.runner';
import { IntakeAnalysisJobHandler } from './intake-analysis-job.handler';
import { IntakeAnalysisJobProcessor } from './intake-analysis-job.processor';

@Module({
  imports: [IntakeAnalysisUsecasesModule],
  providers: [
    IntakeAnalysisJobHandler,
    IntakeAnalysisJobProcessor,
    IntakeAnalysisHousekeepingRunner,
  ],
})
export class IntakeAnalysisWorkerAdapterModule {}
