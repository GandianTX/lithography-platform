// src/infrastructure/file-storage/local-runtime-storage-probe.ts

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  LocalRuntimeStorageProbe,
  LocalRuntimeStorageProbeResult,
} from '@src/usecases/local-runtime/local-runtime-storage-probe.contract';

const DEFAULT_BUSINESS_DIR = 'var/reference-documents';
const DEFAULT_BACKUP_DIR = 'var/local-backups';

/**
 * 本机存储位置探测实现。
 *
 * - 配置来源：业务原件目录复用 `referenceDocumentStorage.dir`（与 stored_file 同一存储根），
 *   备份包目录读取 `localRuntime.backupStorageDir`（与业务原件目录分离，避免清理误伤原件）；
 * - 只对配置中的两个目录做 `W_OK` 检查，不创建目录、不遍历子目录；
 * - 相对路径按进程工作目录解析（与 `LocalReferenceDocumentStorage` 一致）。
 */
@Injectable()
export class LocalFileStorageProbe implements LocalRuntimeStorageProbe {
  constructor(private readonly configService: ConfigService) {}

  async probe(): Promise<LocalRuntimeStorageProbeResult> {
    const businessFileDirectory =
      this.configService.get<string>('referenceDocumentStorage.dir') ?? DEFAULT_BUSINESS_DIR;
    const backupDirectory =
      this.configService.get<string>('localRuntime.backupStorageDir') ?? DEFAULT_BACKUP_DIR;

    const [businessFileDirectoryWritable, backupDirectoryWritable] = await Promise.all([
      isWritableDirectory(businessFileDirectory),
      isWritableDirectory(backupDirectory),
    ]);

    return {
      businessFileDirectory,
      businessFileDirectoryWritable,
      backupDirectory,
      backupDirectoryWritable,
    };
  }
}

/** 目录存在且当前进程可写时返回 true；不存在、无权限或非目录一律 false（不抛错） */
async function isWritableDirectory(directory: string): Promise<boolean> {
  try {
    await access(resolve(process.cwd(), directory), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
