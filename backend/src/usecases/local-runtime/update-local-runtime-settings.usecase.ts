// src/usecases/local-runtime/update-local-runtime-settings.usecase.ts

import { DomainError, LOCAL_RUNTIME_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { LocalRuntimeService } from '@src/modules/lithography/local-runtime.service';
import type { LocalInstallationSnapshot } from '@src/modules/lithography/local-runtime.types';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import type { UpdateLocalRuntimeSettingsCommand } from './local-runtime.command.types';
import { normalizeSettingsPatch } from './local-runtime.input.normalize';
import { assertLocalRuntimeSettingsRole } from './local-runtime-roles';

/**
 * 更新本地设置（补丁语义：未提供的字段保持落库值）。
 * 组织映射不在此修改：映射属于管理端配置，需与云端身份核对流程一并设计。
 */
@Injectable()
export class UpdateLocalRuntimeSettingsUsecase {
  constructor(
    private readonly localRuntimeService: LocalRuntimeService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: UpdateLocalRuntimeSettingsCommand): Promise<LocalInstallationSnapshot> {
    assertLocalRuntimeSettingsRole(command.session);
    const patch = normalizeSettingsPatch(command.settings);
    return this.transactionRunner.run(async (transactionContext) => {
      // 先锁后合并：普通读 + 整体覆盖会让并发补丁互相回退对方的字段
      const current = await this.localRuntimeService.lockInstallation(transactionContext);
      if (!current) {
        throw new DomainError(LOCAL_RUNTIME_ERROR.INSTALLATION_NOT_FOUND, '本地安装身份未初始化');
      }
      await this.localRuntimeService.updateInstallationSettings(
        {
          localSiteName:
            patch.localSiteName !== undefined ? patch.localSiteName : current.localSiteName,
          autoUploadEnabled: patch.autoUploadEnabled ?? current.autoUploadEnabled,
          backupIntervalDays: patch.backupIntervalDays ?? current.backupIntervalDays,
        },
        transactionContext,
      );
      const saved = await this.localRuntimeService.lockInstallation(transactionContext);
      if (!saved) {
        throw new DomainError(LOCAL_RUNTIME_ERROR.INSTALLATION_NOT_FOUND, '本地安装身份未初始化');
      }
      return saved;
    });
  }
}
