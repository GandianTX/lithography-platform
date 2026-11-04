// src/usecases/local-runtime/complete-local-upload.usecase.ts

import { Inject, Injectable } from '@nestjs/common';
import { LocalRuntimeService } from '@src/modules/lithography/local-runtime.service';
import type { LocalUploadTaskSnapshot } from '@src/modules/lithography/local-runtime.types';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import type { CompleteLocalUploadCommand } from './local-runtime.command.types';
import {
  normalizeTaskId,
  normalizeUploadReceipt,
  normalizeUploadReceiptText,
} from './local-runtime.input.normalize';

/** 标记上传成功：仅 UPLOADING 可完成；只记录云端标识/回执，不反写业务主键。 */
@Injectable()
export class CompleteLocalUploadUsecase {
  constructor(
    private readonly localRuntimeService: LocalRuntimeService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: CompleteLocalUploadCommand): Promise<LocalUploadTaskSnapshot> {
    const taskId = normalizeTaskId(command.taskId);
    const remoteId = normalizeUploadReceipt(command.remoteId);
    const remoteReceipt = normalizeUploadReceiptText(command.remoteReceipt);
    return this.transactionRunner.run((transactionContext) =>
      this.localRuntimeService.completeUploadTask(
        taskId,
        { remoteId, remoteReceipt },
        transactionContext,
      ),
    );
  }
}
