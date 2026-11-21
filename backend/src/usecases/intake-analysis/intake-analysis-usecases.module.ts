// src/usecases/intake-analysis/intake-analysis-usecases.module.ts

import { AiInfrastructureModule } from '@src/infrastructure/ai/ai-infrastructure.module';
import { AsyncTaskRecordModule } from '@src/modules/async-task-record/async-task-record.module';
import { AiProviderCallRecordModule } from '@src/modules/ai-provider-call-record/ai-provider-call-record.module';
import { AccountInstallerModule } from '@src/modules/account/account-installer.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { IntakeAnalysisQueueModule } from '@src/modules/lithography/queue/intake-analysis-queue.module';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { Module } from '@nestjs/common';
import { ConsumeIntakeAnalysisJobUsecase } from './consume-intake-analysis-job.usecase';
import { IntakeAnalysisWorkerActivationUsecase } from './intake-analysis-worker-activation.usecase';
import { RunIntakeAnalysisHousekeepingUsecase } from './run-intake-analysis-housekeeping.usecase';

@Module({
  imports: [
    TypeOrmTransactionModule,
    // 报修原稿/存储文件等实体的字符串外键闭包含 AccountEntity
    // （customerAccountId、uploadedByAccountId 等）：Worker 消费首析必须连带注册账户闭包
    AccountInstallerModule,
    LithographyModule,
    IntakeAnalysisQueueModule,
    AsyncTaskRecordModule,
    AiProviderCallRecordModule,
    AiInfrastructureModule,
  ],
  providers: [
    ConsumeIntakeAnalysisJobUsecase,
    RunIntakeAnalysisHousekeepingUsecase,
    IntakeAnalysisWorkerActivationUsecase,
  ],
  exports: [
    ConsumeIntakeAnalysisJobUsecase,
    RunIntakeAnalysisHousekeepingUsecase,
    IntakeAnalysisWorkerActivationUsecase,
  ],
})
export class IntakeAnalysisUsecasesModule {}
