// src/usecases/local-runtime/list-local-backup-records.usecase.ts

import { Injectable } from '@nestjs/common';

import type { LocalBackupRecordSnapshot } from '@src/modules/lithography/local-runtime.types';
import { LocalBackupAssetQueryService } from '@src/modules/lithography/queries/local-backup-asset.query.service';
import type { LocalRuntimeListPage } from '@src/modules/lithography/queries/local-runtime.query.service';

import type { ListLocalBackupRecordsCommand } from './local-runtime.command.types';
import { normalizePagination } from './local-runtime.input.normalize';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';

/**
 * 备份记录列表（R081，任务书第 12 节「备份记录」）。
 *
 * 范围口径：
 * - 二级管理员与工程师：只返回本机本公司数据区的备份记录；
 * - 一级管理员：返回本设备全部公司的备份记录；
 * - 客户与受限会话：由范围解析器失败关闭。
 */
@Injectable()
export class ListLocalBackupRecordsUsecase {
  constructor(
    private readonly backupAssetQueryService: LocalBackupAssetQueryService,
    private readonly scopeResolver: LocalRuntimeScopeResolver,
  ) {}

  async execute(
    command: ListLocalBackupRecordsCommand,
  ): Promise<LocalRuntimeListPage<LocalBackupRecordSnapshot>> {
    const scope = await this.scopeResolver.resolve(command.session);
    const pagination = normalizePagination(command.pagination);
    return this.backupAssetQueryService.listRecords(scope.organizationId, pagination);
  }
}
