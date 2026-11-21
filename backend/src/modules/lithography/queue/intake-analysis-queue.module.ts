// src/modules/lithography/queue/intake-analysis-queue.module.ts

import { Module } from '@nestjs/common';
import { BullMqModule } from '@src/infrastructure/bullmq/bullmq.module';
import { IntakeAnalysisCapabilityAnchor } from './intake-analysis.capability';
import { IntakeAnalysisQueueService } from './intake-analysis-queue.service';

@Module({
  imports: [BullMqModule],
  providers: [IntakeAnalysisQueueService, IntakeAnalysisCapabilityAnchor],
  exports: [IntakeAnalysisQueueService],
})
export class IntakeAnalysisQueueModule {}
