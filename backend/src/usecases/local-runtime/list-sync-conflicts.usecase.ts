// src/usecases/local-runtime/list-sync-conflicts.usecase.ts

import { Injectable } from '@nestjs/common';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import type {
  LocalRuntimePagination,
  ListSyncConflictsCommand,
} from './local-runtime.command.types';
import type { SyncConflictListPage } from '@src/modules/lithography/sync.types';
import { SyncConflictQueryService } from '@src/modules/lithography/queries/sync-conflict.query.service';

/**
 * 冲突清单（任务 09 S2.1／R066）。
 *
 * 范围与本地运行数据一致：工程师与二级管理员只看本公司数据区，
 * 一级管理员看本设备全部公司。列表不含正文快照的解包结果，
 * 快照内容只在详情读取。
 */
@Injectable()
export class ListSyncConflictsUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly syncConflictQueryService: SyncConflictQueryService,
  ) {}

  async execute(command: ListSyncConflictsCommand): Promise<SyncConflictListPage> {
    const scope = await this.scopeResolver.resolve(command.session);
    const pagination: LocalRuntimePagination = command.pagination ?? { page: 1, pageSize: 20 };

    return this.syncConflictQueryService.listForScope(
      scope.organizationId,
      {
        page: pagination.page,
        pageSize: pagination.pageSize,
        withTotal: pagination.withTotal,
      },
      { statusOnlyPending: command.statusOnlyPending },
    );
  }
}
