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
import {
  LITHOGRAPHY_ENTITIES,
  LithographyModule,
} from '@src/modules/lithography/lithography.module';
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
import { LocalBackupCleanupService } from '@src/modules/lithography/local-backup-cleanup.service';
import { LocalBackupScheduleRuntime } from './local-backup-schedule.runtime';
import { StoredFileRetentionRuntime } from './stored-file-retention.runtime';
import { StoredFileRetentionService } from '@src/modules/lithography/stored-file-retention.service';
import { CleanupExpiredStoredFilesUsecase } from '@usecases/stored-file/cleanup-expired-stored-files.usecase';
import { LocalBusinessSyncRuntime } from './local-business-sync.runtime';
import { LocalRuntimeUsecasesModule } from '@src/usecases/local-runtime/local-runtime-usecases.module';

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
    LocalRuntimeUsecasesModule,
    // 过期暂存原件清理链需要任务 11 的受控写入服务（StoredFileService）：
    // 直接导入业务模块，避免在清理链里另写一份"释放暂存行"的条件更新（真重复）。
    LithographyModule,
  ],
  providers: [
    BullMqWorkerRuntime,
    ProtectedBackupService,
    LocalBackupCleanupService,
    BackupScheduleService,
    LocalBackupUploadService,
    LocalBackupScheduleRuntime,
    LocalBusinessSyncRuntime,
    // 过期暂存原件清理（任务 09 P3-3 跨资源失败补偿）：
    // 释放到期且未被业务引用的暂存行并回收存储字节（行保留可追踪）。
    StoredFileRetentionService,
    CleanupExpiredStoredFilesUsecase,
    StoredFileRetentionRuntime,
  ],
})
export class WorkerModule {}
