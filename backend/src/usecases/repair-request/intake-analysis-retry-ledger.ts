// src/usecases/repair-request/intake-analysis-retry-ledger.ts
// 首析自助资格：投递意图账本事实的跨模块只读核对（usecase 层编排）。
//
// 为什么需要账本事实：
// - 首析投递意图（base_async_task_record 行）在提交/重试事务内与代次同时登记，
//   是「该代次确由任务 03 正式入口登记过」的唯一持久化证据；
// - 缺少该行说明记录不可信（历史样例、人工写入或数据被清理），此时不开放自助重试；
// - 账本读取失败（能力停用、账本表不可读）一律失败关闭：返回 false，
//   不把内部异常上抛给客户，也不据此放行。
//
// 该核对只解决「记录是否存在」，不参与失败判定：失败真假只看原稿与当前代次
// 尝试行的实际结果，绝不依据账本 failed / worker_permanent: 前缀。

import {
  buildIntakeAnalysisJobId,
  INTAKE_ANALYSIS_QUEUE_NAME,
} from '@core/common/async-task/intake-analysis-job-id.policy';
import type { AsyncTaskRecordQueryService } from '@src/modules/async-task-record/queries/async-task-record.query.service';

/**
 * 当前代次的投递意图账本行是否存在。
 *
 * 确定性 jobId（`intake-analysis:{intakeId}:g{generation}`）+ 队列名是账本唯一键
 * `(queue_name, job_id)`，因此「行存在」即可证明该代次登记过投递意图。
 */
export async function readIntakeAnalysisLedgerIntentPresent(
  queryService: AsyncTaskRecordQueryService,
  params: { readonly intakeId: number; readonly generationNo: number },
): Promise<boolean> {
  try {
    const record = await queryService.findByQueueJob({
      where: {
        queueName: INTAKE_ANALYSIS_QUEUE_NAME,
        jobId: buildIntakeAnalysisJobId({
          intakeId: params.intakeId,
          generationNo: params.generationNo,
        }),
      },
    });
    return record !== null;
  } catch {
    // 能力停用或账本不可读：失败关闭（不开放自助重试），不泄露内部异常
    return false;
  }
}
