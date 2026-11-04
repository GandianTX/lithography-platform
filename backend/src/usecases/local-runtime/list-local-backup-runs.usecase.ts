// src/usecases/local-runtime/list-local-backup-runs.usecase.ts

import { Injectable } from '@nestjs/common';
import {
  LocalRuntimeQueryService,
  type LocalRuntimeListPage,
} from '@src/modules/lithography/queries/local-runtime.query.service';
import type { LocalBackupRunSnapshot } from '@src/modules/lithography/local-runtime.types';
import type { ListLocalBackupRunsCommand } from './local-runtime.command.types';
import { normalizePagination } from './local-runtime.input.normalize';
import { assertLocalRuntimeSettingsRole } from './local-runtime-roles';

/** 备份运行清单（管理员）：开始时间倒序分页。 */
@Injectable()
export class ListLocalBackupRunsUsecase {
  constructor(private readonly localRuntimeQueryService: LocalRuntimeQueryService) {}

  async execute(
    command: ListLocalBackupRunsCommand,
  ): Promise<LocalRuntimeListPage<LocalBackupRunSnapshot>> {
    assertLocalRuntimeSettingsRole(command.session);
    const pagination = normalizePagination(command.pagination);
    return this.localRuntimeQueryService.listBackupRuns(pagination);
  }
}
