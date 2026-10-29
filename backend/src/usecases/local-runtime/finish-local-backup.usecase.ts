// src/usecases/local-runtime/finish-local-backup.usecase.ts

import { Inject, Injectable } from '@nestjs/common';
import { LocalRuntimeService } from '@src/modules/lithography/local-runtime.service';
import type { LocalBackupRunSnapshot } from '@src/modules/lithography/local-runtime.types';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import type { FinishLocalBackupCommand } from './local-runtime.command.types';
import { normalizeBackupFinish, normalizeRunId } from './local-runtime.input.normalize';

/**
 * 结束备份运行：仅 RUNNING 可结束，成功必须有清单校验值，失败必须有错误码与说明；
 * 结束时间取服务端事件时间。成功会刷新安装的最近成功备份时间。
 */
@Injectable()
export class FinishLocalBackupUsecase {
  constructor(
    private readonly localRuntimeService: LocalRuntimeService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: FinishLocalBackupCommand): Promise<LocalBackupRunSnapshot> {
    const runId = normalizeRunId(command.runId);
    const finishData = normalizeBackupFinish(command, new Date());
    return this.transactionRunner.run((transactionContext) =>
      this.localRuntimeService.finishBackupRun(runId, finishData, transactionContext),
    );
  }
}
