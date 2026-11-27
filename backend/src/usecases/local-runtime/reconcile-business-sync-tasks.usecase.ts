// src/usecases/local-runtime/reconcile-business-sync-tasks.usecase.ts

import { BUSINESS_SYNC_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';

import { BusinessSyncSourceService } from '@src/modules/lithography/business-sync-source.service';
import { LocalRuntimeService } from '@src/modules/lithography/local-runtime.service';
import { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';

import { EnqueueSourceRecordSyncUsecase } from './enqueue-source-record-sync.usecase';
import type {
  ReconcileBusinessSyncTasksCommand,
  ReconcileBusinessSyncTasksResult,
} from './local-runtime.command.types';

/**
 * 业务同步待办对账（任务 09 S2.1 的"接通"环节）。
 *
 * 本机是"离线优先"的：来源记录在本机被编辑／提交后，云端还没有对应事实。
 * 本用例按周期把**当前版本**的来源记录与待传任务对齐：
 *
 * 1. 逐条走登记用例（准入裁决在那一层）：缺失身份事实、已下架、原账号授权失效
 *    的记录一律不生成任务，只按受控原因码计数；
 * 2. 同一（稳定键, 版本）重复对账命中既有任务，不重复登记；
 * 3. 已删除／下架／撤回的记录：把它的待办取消（`CANCELLED`），避免下架后重放。
 *
 * 失败处理：单条失败不拖垮整轮（按原因码计数后继续），整轮异常由调用方记录。
 */
@Injectable()
export class ReconcileBusinessSyncTasksUsecase {
  constructor(
    private readonly enqueueSourceRecordSyncUsecase: EnqueueSourceRecordSyncUsecase,
    private readonly businessSyncSourceService: BusinessSyncSourceService,
    private readonly localRuntimeService: LocalRuntimeService,
    private readonly localRuntimeQueryService: LocalRuntimeQueryService,
    private readonly localWriteHoldService: LocalWriteHoldService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(
    command: ReconcileBusinessSyncTasksCommand = {},
  ): Promise<ReconcileBusinessSyncTasksResult> {
    const limit = command.limit ?? undefined;
    const installation = await this.localRuntimeQueryService.readInstallation();
    if (!installation) {
      throw new DomainError(BUSINESS_SYNC_ERROR.INVALID_PARAMS, '本地安装身份未初始化');
    }
    const organizationId = installation.organizationId;
    if (organizationId === null) {
      throw new DomainError(
        BUSINESS_SYNC_ERROR.INVALID_PARAMS,
        '本机未映射云端组织，无法确定数据区归属',
      );
    }

    const result: ReconcileBusinessSyncTasksResult = {
      scanned: 0,
      created: 0,
      existing: 0,
      rejected: 0,
      cancelled: 0,
      rejections: {},
    };

    // 恢复期冻结：该公司数据区正在恢复时整轮对账不执行（停写停传）
    await this.localWriteHoldService.assertCompanyWritable({ organizationId });

    for (const resourceType of this.businessSyncSourceService.listSupportedResourceTypes()) {
      const candidates = await this.businessSyncSourceService.listCandidates(
        organizationId,
        resourceType,
        limit,
      );
      for (const candidate of candidates) {
        result.scanned += 1;
        if (candidate.recordUuid === null) {
          // 历史行只有本机派生键：跨端身份不成立，不生成任务，也不回填派生值
          this.countRejection(result, BUSINESS_SYNC_ERROR.SOURCE_IDENTITY_UNTRUSTED);
          result.rejected += 1;
          continue;
        }
        if (candidate.withdrawn) {
          result.cancelled += await this.cancelWithdrawnTasks(
            installation.installationId,
            candidate.recordUuid,
          );
          continue;
        }
        try {
          const enqueued = await this.enqueueSourceRecordSyncUsecase.execute({
            resourceType,
            recordUuid: candidate.recordUuid,
          });
          if (enqueued.created) {
            result.created += 1;
          } else {
            result.existing += 1;
          }
        } catch (error) {
          this.countRejection(result, errorCodeOf(error));
          result.rejected += 1;
        }
      }
    }

    return result;
  }

  /**
   * 下架／撤回记录的待办取消：只取消还没成功的任务。
   * 已成功的历史同步不回滚（云端事实已经成立），只清理仍待派发的部分。
   */
  private async cancelWithdrawnTasks(installationId: string, recordUuid: string): Promise<number> {
    const tasks = await this.localRuntimeQueryService.listBusinessSyncTasksByRecordUuid(
      installationId,
      recordUuid,
    );
    let cancelled = 0;
    for (const task of tasks) {
      if (task.status !== 'PENDING' && task.status !== 'FAILED') {
        continue;
      }
      try {
        await this.transactionRunner.run((transactionContext) =>
          this.localRuntimeService.cancelUploadTask(
            task.id,
            {
              errorCode: BUSINESS_SYNC_ERROR.SOURCE_WITHDRAWN,
              errorMessage: '来源记录已删除或下架，待传任务不再派发',
            },
            transactionContext,
          ),
        );
        cancelled += 1;
      } catch {
        // 单条取消失败不拖垮整轮：下一轮继续对账
      }
    }
    return cancelled;
  }

  /** 按受控原因码累计拒绝次数 */
  private countRejection(result: ReconcileBusinessSyncTasksResult, code: string): void {
    result.rejections[code] = (result.rejections[code] ?? 0) + 1;
  }
}

/** 拒绝原因码：DomainError 取其 code，其余归入"未知原因" */
function errorCodeOf(error: unknown): string {
  if (error instanceof DomainError) {
    return error.code;
  }
  return BUSINESS_SYNC_ERROR.INVALID_PARAMS;
}
