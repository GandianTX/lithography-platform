// src/usecases/local-runtime/local-runtime-usecases.module.ts

import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { Module } from '@nestjs/common';
import { CompleteLocalUploadUsecase } from './complete-local-upload.usecase';
import { EnqueueLocalUploadUsecase } from './enqueue-local-upload.usecase';
import { FailLocalUploadUsecase } from './fail-local-upload.usecase';
import { FinishLocalBackupUsecase } from './finish-local-backup.usecase';
import { GetLocalRuntimeSettingsUsecase } from './get-local-runtime-settings.usecase';
import { ListLocalBackupRunsUsecase } from './list-local-backup-runs.usecase';
import { ListLocalUploadTasksUsecase } from './list-local-upload-tasks.usecase';
import { StartLocalBackupUsecase } from './start-local-backup.usecase';
import { StartLocalUploadAttemptUsecase } from './start-local-upload-attempt.usecase';
import { UpdateLocalRuntimeSettingsUsecase } from './update-local-runtime-settings.usecase';

/**
 * 本地运行数据用例装配（S4）。
 *
 * 设置读写为管理员入口；上传/备份运行用例为本地代理/调度器内部入口，
 * 本轮不暴露 GraphQL 字段，真实接收端接入后再补充鉴权通道。
 */
@Module({
  imports: [LithographyModule],
  providers: [
    GetLocalRuntimeSettingsUsecase,
    UpdateLocalRuntimeSettingsUsecase,
    EnqueueLocalUploadUsecase,
    StartLocalUploadAttemptUsecase,
    CompleteLocalUploadUsecase,
    FailLocalUploadUsecase,
    StartLocalBackupUsecase,
    FinishLocalBackupUsecase,
    ListLocalUploadTasksUsecase,
    ListLocalBackupRunsUsecase,
  ],
  exports: [
    GetLocalRuntimeSettingsUsecase,
    UpdateLocalRuntimeSettingsUsecase,
    EnqueueLocalUploadUsecase,
    StartLocalUploadAttemptUsecase,
    CompleteLocalUploadUsecase,
    FailLocalUploadUsecase,
    StartLocalBackupUsecase,
    FinishLocalBackupUsecase,
    ListLocalUploadTasksUsecase,
    ListLocalBackupRunsUsecase,
  ],
})
export class LocalRuntimeUsecasesModule {}
