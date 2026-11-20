// src/modules/lithography/queue/intake-analysis-queue.module.ts

import { Module } from '@nestjs/common';
import { IntakeAnalysisCapabilityAnchor } from './intake-analysis.capability';
import { IntakeAnalysisQueueService } from './intake-analysis-queue.service';

@Module({
  providers: [IntakeAnalysisQueueService, IntakeAnalysisCapabilityAnchor],
  exports: [IntakeAnalysisQueueService],
})
export class IntakeAnalysisQueueModule {}
