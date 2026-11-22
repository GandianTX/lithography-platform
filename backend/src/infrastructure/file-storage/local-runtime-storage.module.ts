// src/infrastructure/file-storage/local-runtime-storage.module.ts

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LOCAL_RUNTIME_STORAGE_PROBE } from '@src/usecases/common/ports/local-runtime-storage-probe.contract';
import {
  LOCAL_BACKUP_PROTECTION,
  LOCAL_BACKUP_STORAGE,
  type LocalBackupStorageConfig,
  type ProtectedBackupMaterial,
} from '@src/usecases/common/ports/protected-backup.contract';

import { LocalFileStorageProbe } from './local-runtime-storage-probe';

/**
 * 本地运行数据存储装配（任务 09 S1/S3）。
 *
 * - S1：只读探测实现；
 * - S3（D-7）：受保护备份的密钥材料与包落点配置经本模块 wiring 注入，
 *   服务层只消费 contract type；密钥不进日志、不经 API 返回、不落包；
 *   密钥未配置时注入 null（封包按失败关闭处理，不产出可用包）。
 */
@Module({
  providers: [
    { provide: LOCAL_RUNTIME_STORAGE_PROBE, useClass: LocalFileStorageProbe },
    {
      provide: LOCAL_BACKUP_PROTECTION,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): ProtectedBackupMaterial | null => {
        const keyHex = configService.get<string>('localRuntime.protectionKey');
        if (!keyHex) {
          return null;
        }
        return {
          keyHex,
          keyId: configService.get<string>('localRuntime.protectionKeyId') ?? 'unconfigured',
        };
      },
    },
    {
      provide: LOCAL_BACKUP_STORAGE,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): LocalBackupStorageConfig => ({
        baseDir: configService.get<string>('localRuntime.backupStorageDir') ?? 'var/local-backups',
      }),
    },
  ],
  exports: [LOCAL_RUNTIME_STORAGE_PROBE, LOCAL_BACKUP_PROTECTION, LOCAL_BACKUP_STORAGE],
})
export class LocalRuntimeStorageModule {}
