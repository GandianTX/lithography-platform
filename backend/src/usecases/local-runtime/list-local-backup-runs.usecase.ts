// src/usecases/local-runtime/list-local-backup-runs.usecase.ts

import { assertLocalRuntimeAdministrator } from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';
import { Injectable } from '@nestjs/common';
import {
  LocalRuntimeQueryService,
  type LocalRuntimeListPage,
} from '@src/modules/lithography/queries/local-runtime.query.service';
import type { LocalBackupRunSnapshot } from '@src/modules/lithography/local-runtime.types';
import type { ListLocalBackupRunsCommand } from './local-runtime.command.types';
import { normalizePagination } from './local-runtime.input.normalize';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';

/**
 * 备份运行清单：开始时间倒序分页。
 *
 * 准入暂限管理员（一级/二级）：备份运行行按公司可空（旧行无公司），
 * 工程师可见的本公司清单随 S3 的 R081 备份清单视图（含公司过滤）一并开放。
 */
@Injectable()
export class ListLocalBackupRunsUsecase {
  constructor(
    private readonly localRuntimeQueryService: LocalRuntimeQueryService,
    private readonly scopeResolver: LocalRuntimeScopeResolver,
  ) {}

  async execute(
    command: ListLocalBackupRunsCommand,
  ): Promise<LocalRuntimeListPage<LocalBackupRunSnapshot>> {
    const scope = await this.scopeResolver.resolve(command.session);
    assertLocalRuntimeAdministrator(scope);
    const pagination = normalizePagination(command.pagination);
    return this.localRuntimeQueryService.listBackupRuns(pagination);
  }
}
