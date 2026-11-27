// src/usecases/local-runtime/list-local-upload-tasks.usecase.ts

import { assertLocalRuntimeAdministrator } from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';
import { Injectable } from '@nestjs/common';
import {
  LocalRuntimeQueryService,
  type LocalRuntimeListPage,
} from '@src/modules/lithography/queries/local-runtime.query.service';
import type { LocalUploadTaskSnapshot } from '@src/modules/lithography/local-runtime.types';
import type { ListLocalUploadTasksCommand } from './local-runtime.command.types';
import { normalizePagination, normalizeUploadStatus } from './local-runtime.input.normalize';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';

/**
 * 上传任务清单：创建时间升序分页，可按状态筛选。
 *
 * 准入暂限管理员（一级/二级）。原因：`local_upload_task` 没有公司列（S0 证据 G-8），
 * 无法在不跨公司泄露的前提下给工程师返回清单；按公司过滤的工程入口随 S2 的
 * 同步归属设计一并开放，当前对工程师失败关闭。
 */
@Injectable()
export class ListLocalUploadTasksUsecase {
  constructor(
    private readonly localRuntimeQueryService: LocalRuntimeQueryService,
    private readonly scopeResolver: LocalRuntimeScopeResolver,
  ) {}

  async execute(
    command: ListLocalUploadTasksCommand,
  ): Promise<LocalRuntimeListPage<LocalUploadTaskSnapshot>> {
    const scope = await this.scopeResolver.resolve(command.session);
    assertLocalRuntimeAdministrator(scope);
    const pagination = normalizePagination(command.pagination);
    const status = normalizeUploadStatus(command.status);
    return this.localRuntimeQueryService.listUploadTasks(
      pagination,
      status === undefined ? {} : { status },
    );
  }
}
