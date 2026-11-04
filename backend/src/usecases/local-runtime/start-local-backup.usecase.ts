// src/usecases/local-runtime/start-local-backup.usecase.ts

import { DomainError, LOCAL_RUNTIME_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { LocalRuntimeService } from '@src/modules/lithography/local-runtime.service';
import type { LocalBackupRunSnapshot } from '@src/modules/lithography/local-runtime.types';
import { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import type { StartLocalBackupCommand } from './local-runtime.command.types';
import { normalizeBackupTrigger, normalizeManifestPath } from './local-runtime.input.normalize';

/**
 * 开始备份运行（本地代理/调度器入口）。
 *
 * 同一安装同一时刻仅允许一个 RUNNING：服务层先锁读再插入，数据库生成列唯一键兜底；
 * 开始时间取服务端事件时间。
 */
@Injectable()
export class StartLocalBackupUsecase {
  constructor(
    private readonly localRuntimeService: LocalRuntimeService,
    private readonly localRuntimeQueryService: LocalRuntimeQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: StartLocalBackupCommand): Promise<LocalBackupRunSnapshot> {
    const triggerType = normalizeBackupTrigger(command.triggerType);
    const manifestPath = normalizeManifestPath(command.manifestPath);
    return this.transactionRunner.run(async (transactionContext) => {
      const installation = await this.localRuntimeQueryService.readInstallation(transactionContext);
      if (!installation) {
        throw new DomainError(LOCAL_RUNTIME_ERROR.INSTALLATION_NOT_FOUND, '本地安装身份未初始化');
      }
      return this.localRuntimeService.insertBackupRun(
        {
          installationId: installation.installationId,
          triggerType,
          startedAt: new Date(),
          manifestPath,
        },
        transactionContext,
      );
    });
  }
}
