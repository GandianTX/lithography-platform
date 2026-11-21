// src/usecases/local-runtime/local-runtime-usecases.module.ts

import { AccountInstallerModule } from '@src/modules/account/account-installer.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { LocalRuntimeStorageModule } from '@src/infrastructure/file-storage/local-runtime-storage.module';
import { Module } from '@nestjs/common';
import { CompleteLocalUploadUsecase } from './complete-local-upload.usecase';
import { EnqueueLocalUploadUsecase } from './enqueue-local-upload.usecase';
import { FailLocalUploadUsecase } from './fail-local-upload.usecase';
import { FinishLocalBackupUsecase } from './finish-local-backup.usecase';
import { GetLocalRuntimeSettingsUsecase } from './get-local-runtime-settings.usecase';
import { GetLocalRuntimeStatusUsecase } from './get-local-runtime-status.usecase';
import { ListLocalBackupRunsUsecase } from './list-local-backup-runs.usecase';
import { ListLocalUploadTasksUsecase } from './list-local-upload-tasks.usecase';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import { GetSyncConflictUsecase } from './get-sync-conflict.usecase';
import { ListSyncConflictsUsecase } from './list-sync-conflicts.usecase';
import { RenewMyLocalAuthorizationUsecase } from './renew-my-local-authorization.usecase';
import {
  CheckRecordPackageUsecase,
  GetRecordPackageResultUsecase,
} from './check-record-package.usecase';
import { ExportRecordPackageUsecase } from './export-record-package.usecase';
import { GetLocalBackupRecordUsecase } from './get-local-backup-record.usecase';
import { GetLocalBackupSettingsUsecase } from './get-local-backup-settings.usecase';
import { ListLocalBackupRecordsUsecase } from './list-local-backup-records.usecase';
import { StartManualLocalBackupUsecase } from './start-manual-local-backup.usecase';
import { PrecheckLocalRestoreUsecase } from './precheck-local-restore.usecase';
import { CleanupLocalBackupPackagesUsecase } from './cleanup-local-backup-packages.usecase';
import { ResolveSyncConflictUsecase } from './resolve-sync-conflict.usecase';
import { StartLocalBackupUsecase } from './start-local-backup.usecase';
import { StartLocalUploadAttemptUsecase } from './start-local-upload-attempt.usecase';
import { UpdateLocalRuntimeSettingsUsecase } from './update-local-runtime-settings.usecase';

/**
 * 本地运行数据用例装配（任务 09 S1 起）。
 *
 * 读侧（运行状态、设置、清单）按 1 级/2 级/工程师本公司口径鉴权；
 * 上传/备份运行的登记用例仍是本地代理与调度器的内部入口，不经用户 Session，
 * 真实接收端接入前不暴露 GraphQL（S2/S3 另建显式内部通道）。
 */
@Module({
  imports: [LithographyModule, AccountInstallerModule, LocalRuntimeStorageModule],
  providers: [
    LocalRuntimeScopeResolver,
    GetLocalRuntimeStatusUsecase,
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
    GetSyncConflictUsecase,
    ListSyncConflictsUsecase,
    ResolveSyncConflictUsecase,
    RenewMyLocalAuthorizationUsecase,
    CheckRecordPackageUsecase,
    GetRecordPackageResultUsecase,
    ExportRecordPackageUsecase,
    ListLocalBackupRecordsUsecase,
    GetLocalBackupRecordUsecase,
    GetLocalBackupSettingsUsecase,
    StartManualLocalBackupUsecase,
    PrecheckLocalRestoreUsecase,
    CleanupLocalBackupPackagesUsecase,
  ],
  exports: [
    LocalRuntimeScopeResolver,
    GetLocalRuntimeStatusUsecase,
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
    GetSyncConflictUsecase,
    ListSyncConflictsUsecase,
    ResolveSyncConflictUsecase,
    RenewMyLocalAuthorizationUsecase,
    CheckRecordPackageUsecase,
    GetRecordPackageResultUsecase,
    ExportRecordPackageUsecase,
    ListLocalBackupRecordsUsecase,
    GetLocalBackupRecordUsecase,
    GetLocalBackupSettingsUsecase,
    StartManualLocalBackupUsecase,
    PrecheckLocalRestoreUsecase,
    CleanupLocalBackupPackagesUsecase,
  ],
})
export class LocalRuntimeUsecasesModule {}
