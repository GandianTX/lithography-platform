// src/usecases/local-runtime/get-local-backup-settings.usecase.ts

import { DomainError, LOCAL_RUNTIME_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';

import type { LocalBackupSettingSnapshot } from '@src/modules/lithography/local-runtime.types';
import { LocalBackupAssetQueryService } from '@src/modules/lithography/queries/local-backup-asset.query.service';
import { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';

import type { GetLocalBackupSettingsCommand } from './local-runtime.command.types';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';

/**
 * 自动备份设置（R078／任务书第 12 节「自动备份设置」）。
 *
 * - 只读展示当前有权公司的计划、下次时间与最近结果；
 * - 约 72 小时计划周期与约 30 天保留窗口是需求固定口径，由服务层只读给出，不写库；
 * - 首次初始化前的公司没有配置行时返回空数组（不凭空造计划）。
 */
@Injectable()
export class GetLocalBackupSettingsUsecase {
  constructor(
    private readonly localRuntimeQueryService: LocalRuntimeQueryService,
    private readonly backupAssetQueryService: LocalBackupAssetQueryService,
    private readonly scopeResolver: LocalRuntimeScopeResolver,
  ) {}

  async execute(command: GetLocalBackupSettingsCommand): Promise<LocalBackupSettingSnapshot[]> {
    const scope = await this.scopeResolver.resolve(command.session);
    const installation = await this.localRuntimeQueryService.readInstallation();
    if (!installation) {
      throw new DomainError(LOCAL_RUNTIME_ERROR.INSTALLATION_NOT_FOUND, '本地安装身份未初始化');
    }
    return this.backupAssetQueryService.listSettings(
      installation.installationId,
      scope.organizationId,
    );
  }
}
