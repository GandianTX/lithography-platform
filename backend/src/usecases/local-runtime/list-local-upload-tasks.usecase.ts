// src/usecases/local-runtime/list-local-upload-tasks.usecase.ts

import { Injectable } from '@nestjs/common';
import {
  LocalRuntimeQueryService,
  type LocalRuntimeListPage,
} from '@src/modules/lithography/queries/local-runtime.query.service';
import type { LocalUploadTaskSnapshot } from '@src/modules/lithography/local-runtime.types';
import type { ListLocalUploadTasksCommand } from './local-runtime.command.types';
import { normalizePagination, normalizeUploadStatus } from './local-runtime.input.normalize';
import { assertLocalRuntimeSettingsRole } from './local-runtime-roles';

/** 上传任务清单（管理员）：创建时间升序分页，可按状态筛选。 */
@Injectable()
export class ListLocalUploadTasksUsecase {
  constructor(private readonly localRuntimeQueryService: LocalRuntimeQueryService) {}

  async execute(
    command: ListLocalUploadTasksCommand,
  ): Promise<LocalRuntimeListPage<LocalUploadTaskSnapshot>> {
    assertLocalRuntimeSettingsRole(command.session);
    const pagination = normalizePagination(command.pagination);
    const status = normalizeUploadStatus(command.status);
    return this.localRuntimeQueryService.listUploadTasks(
      pagination,
      status === undefined ? {} : { status },
    );
  }
}
