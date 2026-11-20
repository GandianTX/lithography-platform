// src/usecases/ai-conversation/ai-question-analysis-settlement.service.ts
// 任务05 Q01／S2.1-6 纠偏：把「执行已终止但 analysis 未收敛」的补偿写入
// 从读取路径挪到正式运行入口（Worker 生命周期扫描）。
//
// 背景（2026-11-20 核验）：此前 `GetAiQuestionStatusUsecase` 在读状态时会调用
// 恢复编排，可能重新投递任务并写 analysis 状态——读权限被隐式赋予了写入能力，
// 与「状态查询只读、恢复由正式运行入口负责」的约定冲突。
//
// 现在职责拆分：
// - 准入／投递重试与准入超时的 workflow 侧收敛：`RunAiWorkflowHousekeepingUsecase`
//   （已有实现，由 Worker 生命周期定时触发）；
// - 本服务只做「**最新**执行已是终态失败/取消，但 analysis 仍 PENDING」的补写。
//
// 关键约束（2026-11-20 自查发现的竞态）：
// 不能只看「窗口内存在失败执行」就写失败。用户在同一 questionUuid 上重试后，
// 新执行可能在运行中、analysis 处于 PENDING；此时若把 analysis 写成 FAILED，
// 新执行的回答写入（条件更新同样要求 PENDING）会被自己挡掉，答案丢失。
// 因此逐个候选回读**最新**执行，只有最新执行确为 FAILED/CANCELLED 才收敛，
// 并在写入前确认当前没有活动执行。写入本身仍受「仅 PENDING 生效」兜底，重复扫描幂等。

import { Inject, Injectable, Logger } from '@nestjs/common';

import { AiConversationService } from '@src/modules/lithography/ai-conversation.service';
import { AI_CONVERSATION_REPLY_WORKFLOW_TYPE } from '@src/usecases/ai-conversation/ai-conversation-dispatch.types';
import {
  AI_CONVERSATION_EXECUTION_LOOKUP,
  type AiConversationExecutionLookupPort,
} from '@src/usecases/common/ports/ai-conversation-execution.contract';

/** 05 会话在 workflow context 中的业务类型（与 dispatch 写入保持一致） */
const AI_CONVERSATION_BIZ_TYPE = 'ai_conversation';

/** 执行已终止且不可能再产出回答的状态：业务侧必须收敛为可重试失败 */
const TERMINAL_FAILED_STATUSES = new Set(['FAILED', 'CANCELLED']);

/** 单次扫描的默认批量上限（与 housekeeping 的默认批量保持同一量级） */
export const AI_QUESTION_SETTLEMENT_DEFAULT_LIMIT = 50;

export type AiQuestionSettlementSweepResult = {
  /** 扫描到的终态执行条数 */
  readonly scanned: number;
  /** 实际补写为失败的 analysis 条数 */
  readonly settled: number;
  /** 因仍有活动执行／最新执行非失败而跳过的条数 */
  readonly skipped: number;
};

@Injectable()
export class AiQuestionAnalysisSettlementService {
  private readonly logger = new Logger(AiQuestionAnalysisSettlementService.name);

  constructor(
    @Inject(AI_CONVERSATION_EXECUTION_LOOKUP)
    private readonly executionLookup: AiConversationExecutionLookupPort,
    private readonly aiConversationService: AiConversationService,
  ) {}

  /**
   * 扫描窗口内进入终态的执行，把仍未收敛的 analysis 补写为可重试失败。
   *
   * @param input.since 窗口下界（通常是「上次扫描时间 − 回看容差」）
   * @param input.limit 单次处理上限
   */
  async sweep(input: {
    readonly since: Date;
    readonly limit?: number;
  }): Promise<AiQuestionSettlementSweepResult> {
    const limit = input.limit ?? AI_QUESTION_SETTLEMENT_DEFAULT_LIMIT;
    const terminated = await this.executionLookup.listTerminalExecutionsSince({
      workflowType: AI_CONVERSATION_REPLY_WORKFLOW_TYPE,
      updatedSince: input.since,
      limit,
    });

    // 同一 question 可能有多条历史失败执行：按业务子键去重，只回读一次最新执行
    const questionUuids = [...new Set(terminated.map((execution) => execution.bizSubKey))];

    let settled = 0;
    let skipped = 0;
    for (const questionUuid of questionUuids) {
      try {
        const active = await this.executionLookup.findActiveExecutionByBizTarget({
          workflowType: AI_CONVERSATION_REPLY_WORKFLOW_TYPE,
          bizType: AI_CONVERSATION_BIZ_TYPE,
          bizSubKey: questionUuid,
        });
        if (active !== null) {
          // 重试后的新执行仍在进行中：此时 analysis 的 PENDING 是「正在生成」，
          // 不能写失败（否则会挡掉新执行的回答写入）
          skipped += 1;
          continue;
        }

        const latest = await this.executionLookup.findLatestExecutionByBizTarget({
          workflowType: AI_CONVERSATION_REPLY_WORKFLOW_TYPE,
          bizType: AI_CONVERSATION_BIZ_TYPE,
          bizSubKey: questionUuid,
        });
        if (latest === null || !TERMINAL_FAILED_STATUSES.has(latest.status)) {
          skipped += 1;
          continue;
        }

        const changed = await this.aiConversationService.markAnalysisFailed({
          questionUuid,
          reason: `workflow_${latest.status.toLowerCase()}`,
        });
        if (changed) {
          settled += 1;
          this.logger.warn(
            {
              questionUuid,
              workflowId: latest.workflowId,
              workflowStatus: latest.status,
            },
            'AI 执行已终止但分析未收敛，已补写为可重试失败',
          );
        }
      } catch (error: unknown) {
        // 单条失败不影响其余候选；下一轮扫描会重试（写入条件幂等）
        this.logger.warn(
          {
            questionUuid,
            error: error instanceof Error ? error.message.slice(0, 200) : 'settle_error',
          },
          'AI 执行终止后的分析收敛失败，等待下一轮扫描',
        );
      }
    }

    return { scanned: terminated.length, settled, skipped };
  }
}
