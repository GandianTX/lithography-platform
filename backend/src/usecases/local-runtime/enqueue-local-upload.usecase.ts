// src/usecases/local-runtime/enqueue-local-upload.usecase.ts

import { DomainError, LOCAL_RUNTIME_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { LocalRuntimeService } from '@src/modules/lithography/local-runtime.service';
import { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import type {
  EnqueueLocalUploadCommand,
  EnqueueLocalUploadResult,
} from './local-runtime.command.types';
import { normalizeUploadIntent } from './local-runtime.input.normalize';

/**
 * 幂等登记上传意图（本地代理入口，无用户 Session）。
 *
 * 相同幂等键或相同实体版本重复调用返回既有任务，不重复登记；
 * 未初始化安装身份时失败关闭，不凭空创建任务。
 */
@Injectable()
export class EnqueueLocalUploadUsecase {
  constructor(
    private readonly localRuntimeService: LocalRuntimeService,
    private readonly localRuntimeQueryService: LocalRuntimeQueryService,
    private readonly localWriteHoldService: LocalWriteHoldService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: EnqueueLocalUploadCommand): Promise<EnqueueLocalUploadResult> {
    const intent = normalizeUploadIntent(command);
    return this.transactionRunner.run(async (transactionContext) => {
      // 恢复期冻结：该公司数据区正在恢复时不得再登记待传任务（停传）
      // 事务内版本：取范围共享锁并锁定读冻结事实 ⇒ 与恢复建立冻结互斥（P1-1）
      if (intent.organizationId !== null && intent.organizationId !== undefined) {
        await this.localWriteHoldService.assertCompanyWritableInTransaction({
          organizationId: intent.organizationId,
          transactionContext,
        });
      }
      const installation = await this.localRuntimeQueryService.readInstallation(transactionContext);
      if (!installation) {
        throw new DomainError(LOCAL_RUNTIME_ERROR.INSTALLATION_NOT_FOUND, '本地安装身份未初始化');
      }
      const { task, created } = await this.localRuntimeService.enqueueUploadTask(
        { installationId: installation.installationId, ...intent },
        transactionContext,
      );
      return { taskId: task.id, status: task.status, created };
    });
  }
}
