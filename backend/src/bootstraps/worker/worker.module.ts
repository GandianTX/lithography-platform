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
import { TypeOrmModule } from '@nestjs/typeorm';
import { LITHOGRAPHY_ENTITIES } from '@src/modules/lithography/lithography.module';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { AiProviderCallRecordEntity } from '@src/modules/ai-provider-call-record/ai-provider-call-record.entity';
import { AiWorkflowContextEntity } from '@src/modules/ai-workflow-context/ai-workflow-context.entity';
import { AsyncTaskRecordEntity } from '@src/modules/async-task-record/async-task-record.entity';
import { ThirdPartyAuthEntity } from '@src/modules/third-party-auth/third-party-auth.entity';
import { VerificationRecordEntity } from '@src/modules/verification-record/verification-record.entity';
import { LocalReferenceDocumentStorageModule } from '@src/infrastructure/file-storage/local-reference-document-storage.module';
import { LocalRuntimeStorageModule } from '@src/infrastructure/file-storage/local-runtime-storage.module';
import { BackupScheduleService } from '@src/modules/lithography/backup-schedule.service';
import { ProtectedBackupService } from '@src/modules/lithography/protected-backup.service';
import { LocalBackupUploadService } from '@src/modules/lithography/local-backup-upload.service';
import { LocalBackupScheduleRuntime } from './local-backup-schedule.runtime';

// Worker 全量实体闭包：业务模块全量实体＋跨模块外键依赖（account 等），
// 保证字符串外键与关系装饰器的元数据构建完整（离线元数据规格同口径）
const WORKER_ENTITIES = [
  ...LITHOGRAPHY_ENTITIES,
  AccountEntity,
  UserInfoEntity,
  AiProviderCallRecordEntity,
  AiWorkflowContextEntity,
  AsyncTaskRecordEntity,
  ThirdPartyAuthEntity,
  VerificationRecordEntity,
] as const;

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
    TypeOrmModule.forFeature([...WORKER_ENTITIES]),
    LocalReferenceDocumentStorageModule,
    LocalRuntimeStorageModule,
  ],
  providers: [
    BullMqWorkerRuntime,
    ProtectedBackupService,
    BackupScheduleService,
    LocalBackupUploadService,
    LocalBackupScheduleRuntime,
  ],
})
export class WorkerModule {}
