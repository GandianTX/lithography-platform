// src/bootstraps/worker/worker.module.ts
import { Module } from '@nestjs/common';
import { AiWorkerAdapterModule } from '@src/adapters/worker/ai/ai-worker-adapter.module';
import { AiWorkflowWorkerAdapterModule } from '@src/adapters/worker/ai-workflow/ai-workflow-worker-adapter.module';
import { EmailWorkerAdapterModule } from '@src/adapters/worker/email/email-worker-adapter.module';
import { IntakeAnalysisWorkerAdapterModule } from '@src/adapters/worker/intake-analysis/intake-analysis-worker-adapter.module';
import { BullMqModule } from '@src/infrastructure/bullmq/bullmq.module';
import { CapabilityModule } from '@src/infrastructure/capability/capability.module';
import { BullMqWorkerRuntime } from '@src/infrastructure/bullmq/worker.runtime';
import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { DatabaseModule } from '@src/infrastructure/database/database.module';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { RedisModule } from '@src/infrastructure/redis/redis.module';

@Module({
  imports: [
    AppConfigModule,
    CapabilityModule.forRoot({ process: 'worker' }),
    LoggerModule,
    DatabaseModule,
    TypeOrmTransactionModule,
    RedisModule,
    BullMqModule,
    AiWorkerAdapterModule,
    AiWorkflowWorkerAdapterModule,
    EmailWorkerAdapterModule,
    IntakeAnalysisWorkerAdapterModule,
  ],
  providers: [BullMqWorkerRuntime],
})
export class WorkerModule {}
