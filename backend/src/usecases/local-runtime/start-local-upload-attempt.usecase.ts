// src/usecases/local-runtime/start-local-upload-attempt.usecase.ts

import { Inject, Injectable } from '@nestjs/common';
import { LocalRuntimeService } from '@src/modules/lithography/local-runtime.service';
import type { LocalUploadTaskSnapshot } from '@src/modules/lithography/local-runtime.types';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import type { LocalUploadTaskCommand } from './local-runtime.command.types';
import { normalizeTaskId } from './local-runtime.input.normalize';

/** 开始一次上传尝试：仅 PENDING/FAILED 可重试，尝试计数与时间由服务端写入。 */
@Injectable()
export class StartLocalUploadAttemptUsecase {
  constructor(
    private readonly localRuntimeService: LocalRuntimeService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: LocalUploadTaskCommand): Promise<LocalUploadTaskSnapshot> {
    const taskId = normalizeTaskId(command.taskId);
    return this.transactionRunner.run((transactionContext) =>
      this.localRuntimeService.startUploadAttempt(taskId, transactionContext),
    );
  }
}
