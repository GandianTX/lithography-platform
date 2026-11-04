// src/usecases/local-runtime/fail-local-upload.usecase.ts

import { Inject, Injectable } from '@nestjs/common';
import { LocalRuntimeService } from '@src/modules/lithography/local-runtime.service';
import type { LocalUploadTaskSnapshot } from '@src/modules/lithography/local-runtime.types';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import type { FailLocalUploadCommand } from './local-runtime.command.types';
import { normalizeTaskId, normalizeUploadFailure } from './local-runtime.input.normalize';

/** 标记上传失败：错误码与说明必填；服务层仅允许 UPLOADING/PENDING 转失败。 */
@Injectable()
export class FailLocalUploadUsecase {
  constructor(
    private readonly localRuntimeService: LocalRuntimeService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: FailLocalUploadCommand): Promise<LocalUploadTaskSnapshot> {
    const taskId = normalizeTaskId(command.taskId);
    const failure = normalizeUploadFailure(command);
    return this.transactionRunner.run((transactionContext) =>
      this.localRuntimeService.failUploadTask(taskId, failure, transactionContext),
    );
  }
}
