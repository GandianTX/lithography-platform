// src/usecases/local-runtime/get-sync-conflict.usecase.ts

import { SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import type { GetSyncConflictCommand } from './local-runtime.command.types';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import { SyncConflictQueryService } from '@src/modules/lithography/queries/sync-conflict.query.service';
import type { SyncConflictSnapshot } from '@src/modules/lithography/sync.types';

/**
 * 冲突详情（任务 09 S2.2／R066）：三方版本、本地/云端快照与可展示原因。
 *
 * 范围内才可见；范围外与不存在同码返回，不区分"没有"与"不让你看"，
 * 避免通过错误码差异探测其他公司数据区。
 */
@Injectable()
export class GetSyncConflictUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly syncConflictQueryService: SyncConflictQueryService,
  ) {}

  async execute(command: GetSyncConflictCommand): Promise<SyncConflictSnapshot> {
    const scope = await this.scopeResolver.resolve(command.session);
    const conflict = await this.syncConflictQueryService.readOne(
      command.conflictId,
      scope.organizationId,
    );
    if (!conflict) {
      throw new DomainError(SYNC_ERROR.CONFLICT_NOT_FOUND, '同步冲突不存在或不在授权范围内');
    }
    return conflict;
  }
}
