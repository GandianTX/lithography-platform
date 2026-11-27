// src/usecases/local-runtime/get-local-backup-record.usecase.ts

import { DomainError, LOCAL_RUNTIME_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';

import type { LocalBackupRecordDetailSnapshot } from '@src/modules/lithography/local-runtime.types';
import { LocalBackupAssetQueryService } from '@src/modules/lithography/queries/local-backup-asset.query.service';

import type { GetLocalBackupRecordCommand } from './local-runtime.command.types';
import { normalizeBackupId } from './local-runtime.input.normalize';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';

/**
 * 备份记录详情（R081，任务书第 12 节「备份记录」行操作）。
 *
 * 范围外与不存在同码返回，避免泄露其他公司备份是否存在；
 * 详情只含清单元数据，不含包正文、密钥材料与他人草稿。
 */
@Injectable()
export class GetLocalBackupRecordUsecase {
  constructor(
    private readonly backupAssetQueryService: LocalBackupAssetQueryService,
    private readonly scopeResolver: LocalRuntimeScopeResolver,
  ) {}

  async execute(command: GetLocalBackupRecordCommand): Promise<LocalBackupRecordDetailSnapshot> {
    const scope = await this.scopeResolver.resolve(command.session);
    const backupId = normalizeBackupId(command.backupId);

    const detail = await this.backupAssetQueryService.readRecordDetail(
      backupId,
      scope.organizationId,
    );
    if (detail === null) {
      throw new DomainError(LOCAL_RUNTIME_ERROR.INVALID_PARAMS, '备份记录不存在');
    }
    return detail;
  }
}
