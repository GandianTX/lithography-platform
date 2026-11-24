// src/infrastructure/cloud/local-backup-cloud.module.ts

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  BUSINESS_SYNC_RECEIVER,
  type BusinessSyncReceiver,
} from '@usecases/common/ports/business-sync-receiver.contract';
import {
  LOCAL_BACKUP_CLOUD_PROVIDER,
  type LocalBackupCloudProvider,
} from '@usecases/common/ports/local-backup-cloud-provider.contract';
import {
  LOCAL_BACKUP_UPLOADER,
  type LocalBackupUploader,
} from '@usecases/common/ports/local-backup-upload.contract';

import { BUSINESS_SYNC_CLOUD_CONFIG, type BusinessSyncCloudConfig } from './business-sync.config';
import { HttpBusinessSyncReceiver } from './http-business-sync-receiver';
import {
  DEFAULT_LOCAL_BACKUP_CLOUD_MAX_UPLOAD_FILE_BYTES,
  DEFAULT_LOCAL_BACKUP_CLOUD_MAX_UPLOAD_PACKAGE_BYTES,
  DEFAULT_LOCAL_BACKUP_CLOUD_TIMEOUT_MS,
  LOCAL_BACKUP_CLOUD_CONFIG,
  type LocalBackupCloudConfig,
} from './local-backup-cloud.config';
import { HttpLocalBackupCloudClient } from './http-local-backup-cloud.client';
import { HttpLocalBackupCloudProvider } from './http-local-backup-cloud-provider';
import { HttpLocalBackupUploader } from './http-local-backup-uploader';

/**
 * 云服务的**生产适配装配**（任务 09 S3.1／S4；业务同步接收端见新计划第 12 项）。
 *
 * 关键口径：
 * - **云服务未接入时不注册端口**：地址或凭据缺失 ⇒ 端口不提供实现，
 *   调用方按受控原因码"云服务未接入"失败关闭（不伪造回执、不伪造可用包）；
 * - **两种用途分端口、分地址、分凭据**：云备份（`LOCAL_BACKUP_UPLOADER`／
 *   `LOCAL_BACKUP_CLOUD_PROVIDER`）与业务同步（`BUSINESS_SYNC_RECEIVER`）互不充数
 *   （凭据用途取自云端签名声明，见 `local-credential-purpose.policy`）；
 * - 凭据只在本模块内注入，不进日志、不进包、不经 API 返回；
 * - 端口在**API 与 Worker 两个进程**都装配（上传发生在 Worker，读取发生在 API）。
 *
 * 超时与大小上限的默认值**只有一份**（`local-backup-cloud.config.ts`），
 * 本模块与 `config.module.ts` 都引用它，避免"两处口径不一致 ⇒ 大包绕过内存闸门"。
 */
@Module({
  providers: [
    {
      provide: LOCAL_BACKUP_CLOUD_CONFIG,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): LocalBackupCloudConfig => ({
        baseUrl: configService.get<string | null>('localRuntime.cloudBackupBaseUrl') ?? null,
        credential: configService.get<string | null>('localRuntime.cloudBackupCredential') ?? null,
        timeoutMs:
          configService.get<number>('localRuntime.cloudBackupTimeoutMs') ??
          DEFAULT_LOCAL_BACKUP_CLOUD_TIMEOUT_MS,
        // 上传大小上限（单文件／整包）：超限按受控原因码失败关闭，不把内存吃光
        maxUploadFileBytes:
          configService.get<number>('localRuntime.cloudBackupMaxUploadFileBytes') ??
          DEFAULT_LOCAL_BACKUP_CLOUD_MAX_UPLOAD_FILE_BYTES,
        maxUploadPackageBytes:
          configService.get<number>('localRuntime.cloudBackupMaxUploadPackageBytes') ??
          DEFAULT_LOCAL_BACKUP_CLOUD_MAX_UPLOAD_PACKAGE_BYTES,
      }),
    },
    HttpLocalBackupCloudClient,
    {
      provide: LOCAL_BACKUP_UPLOADER,
      inject: [HttpLocalBackupCloudClient],
      useFactory: (client: HttpLocalBackupCloudClient): LocalBackupUploader | null =>
        client.configured ? new HttpLocalBackupUploader(client) : null,
    },
    {
      provide: LOCAL_BACKUP_CLOUD_PROVIDER,
      inject: [HttpLocalBackupCloudClient],
      useFactory: (client: HttpLocalBackupCloudClient): LocalBackupCloudProvider | null =>
        client.configured ? new HttpLocalBackupCloudProvider(client) : null,
    },
    {
      provide: BUSINESS_SYNC_CLOUD_CONFIG,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): BusinessSyncCloudConfig => ({
        baseUrl: configService.get<string | null>('localRuntime.businessSyncBaseUrl') ?? null,
        credential: configService.get<string | null>('localRuntime.businessSyncCredential') ?? null,
        timeoutMs: configService.get<number>('localRuntime.businessSyncTimeoutMs') ?? 30_000,
      }),
    },
    HttpBusinessSyncReceiver,
    {
      // 云端业务同步入口**未配置时不注册端口** ⇒ 派发链按"生产接收端缺失"
      // 把任务留在待传状态（可续传），不伪造成功。
      provide: BUSINESS_SYNC_RECEIVER,
      inject: [HttpBusinessSyncReceiver],
      useFactory: (receiver: HttpBusinessSyncReceiver): BusinessSyncReceiver | null =>
        receiver.configured ? receiver : null,
    },
  ],
  exports: [LOCAL_BACKUP_UPLOADER, LOCAL_BACKUP_CLOUD_PROVIDER, BUSINESS_SYNC_RECEIVER],
})
export class LocalBackupCloudModule {}
