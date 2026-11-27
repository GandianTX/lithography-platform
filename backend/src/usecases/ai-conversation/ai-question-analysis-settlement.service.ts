// src/usecases/ai-conversation/ai-question-analysis-settlement.service.ts
// 任务05 Q01／S2.1-6 纠偏：把「执行已终止但 analysis 未收敛」的补偿写入
// 从读取路径挪到正式运行入口（Worker 生命周期扫描）。
//
// 背景（2026-11-20 核验）：此前 `GetAiQuestionStatusUsecase` 在读状态时会调用
// 恢复编排，可能重新投递任务并写 analysis 状态——读权限被隐式赋予了写入能力，
// 与「状态查询只读、恢复由正式运行入口负责」的约定冲突。
//
// 2026-11-20 复验 P2-1（漏扫）：原实现按「最近十分钟内的终态执行」取首批，
// 成功执行与已结算失败会反复占满配额；51 条场景里前 50 条是更早的成功记录，
// 第 51 条未结算失败永远取不到；停机超过回看期的遗漏也不会被重新发现。
// 现改为以「分析仍 PENDING 且无回答」为唯一候选源，按主键键集分页推进，
// 不设时间窗口，满批保留末键、到末尾回绕。
//
// 2026-11-20 复验 P2-2（旧结算覆盖新执行）：原实现先事务外读身份、再按
// UUID＋PENDING 写失败，两次扫描之间有重试插入新执行时，会把新一轮写成 FAILED，
// 从而挡掉新执行的回答写入。现结算与重试共用同一锁序（先会话行锁），
// 在同一事务内重新核对分析事实、活动执行与最新执行，再条件更新。

import { Inject, Injectable, Logger } from '@nestjs/common';

import { AiMessageAnalysisStatus } from '@app-types/models/ai-conversation.types';
import { AiConversationService } from '@src/modules/lithography/ai-conversation.service';
import type { AiPendingAnalysisCandidate } from '@src/modules/lithography/ai-conversation.types';
import { AI_CONVERSATION_REPLY_WORKFLOW_TYPE } from '@src/usecases/ai-conversation/ai-conversation-dispatch.types';
import {
  AI_CONVERSATION_EXECUTION_LOOKUP,
  type AiConversationExecutionLookupPort,
} from '@src/usecases/common/ports/ai-conversation-execution.contract';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';

/** 05 会话在 workflow context 中的业务类型（与 dispatch 写入保持一致） */
const AI_CONVERSATION_BIZ_TYPE = 'ai_conversation';

/**
 * 执行已终止且不可能再产出回答的状态：业务侧必须收敛为可重试失败。
 *
 * 用只读数组而非手工集合：本仓库的 usecases 归一化守卫禁止手工集合去重，
 * 状态数量固定且极小，数组 + `includes` 语义等价且可读性一致。
 */
const TERMINAL_FAILED_STATUSES: readonly string[] = ['FAILED', 'CANCELLED'];

/** 单次扫描的默认批量上限（与 housekeeping 的默认批量保持同一量级） */
export const AI_QUESTION_SETTLEMENT_DEFAULT_LIMIT = 50;

export type AiQuestionSettlementSweepResult = {
  /** 本批读到的候选条数 */
  readonly scanned: number;
  /** 实际补写为失败的 analysis 条数 */
  readonly settled: number;
  /** 因已有活动执行／最新执行非失败／已有回答而跳过的条数 */
  readonly skipped: number;
  /** 单条处理抛错（已被隔离，下一轮回绕时会重新覆盖）的条数 */
  readonly failed: number;
  /**
   * 下一批起点（上一批末键）。`null` 表示本批已到候选末尾，
   * 下一轮从头（回绕）开始，从而重新覆盖此前跳过与异常项。
   */
  readonly nextCursor: string | null;
  /** 本批是否已到候选末尾（下一轮从头开始） */
  readonly reachedEnd: boolean;
};

type SettlementOutcome = 'settled' | 'skipped';

@Injectable()
export class AiQuestionAnalysisSettlementService {
  private readonly logger = new Logger(AiQuestionAnalysisSettlementService.name);

  constructor(
    @Inject(AI_CONVERSATION_EXECUTION_LOOKUP)
    private readonly executionLookup: AiConversationExecutionLookupPort,
    private readonly aiConversationService: AiConversationService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  /**
   * 扫描一批「分析仍 PENDING 且无回答」的候选，把执行已终止的轮次补写为可重试失败。
   *
   * @param input.afterQuestionUuid 上一批末键（keyset）；`null` 表示从头开始
   * @param input.limit 单批处理上限
   */
  async sweep(input: {
    readonly afterQuestionUuid: string | null;
    readonly limit?: number;
  }): Promise<AiQuestionSettlementSweepResult> {
    const limit = input.limit ?? AI_QUESTION_SETTLEMENT_DEFAULT_LIMIT;
    const candidates = await this.aiConversationService.listPendingAnalysisCandidates({
      afterQuestionUuid: input.afterQuestionUuid,
      limit,
    });

    let settled = 0;
    let skipped = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        const outcome = await this.settleCandidate(candidate);
        if (outcome === 'settled') {
          settled += 1;
        } else {
          skipped += 1;
        }
      } catch (error: unknown) {
        // 单条失败不影响其余候选；该条仍在本轮游标内推进，
        // 回绕到头部时会被重新覆盖（写入条件幂等）。
        failed += 1;
        this.logger.warn(
          {
            questionUuid: candidate.questionUuid,
            error: error instanceof Error ? error.message.slice(0, 200) : 'settle_error',
          },
          'AI 执行终止后的分析收敛失败，等待回绕重试',
        );
      }
    }

    const reachedEnd = candidates.length < limit;
    const nextCursor = reachedEnd
      ? null
      : (candidates[candidates.length - 1]?.questionUuid ?? null);
    return { scanned: candidates.length, settled, skipped, failed, nextCursor, reachedEnd };
  }

  /**
   * 单条候选结算：与重试共用锁序（先会话行锁），并在**同一事务**内重新核对：
   * 1. 分析仍属于该会话、仍为 PENDING 且没有回答（候选只用于定位，不授权写入）；
   * 2. 当前没有活动执行（重试后的新一轮仍在生成时不得写失败）；
   * 3. 最新执行确为 FAILED／CANCELLED。
   *
   * 满足以上条件才做条件更新；任一不满足即跳过，不产生写入。
   */
  private async settleCandidate(candidate: AiPendingAnalysisCandidate): Promise<SettlementOutcome> {
    return this.transactionRunner.run<SettlementOutcome>(async (transactionContext) => {
      const conversation = await this.aiConversationService.lockConversationForWrite(
        candidate.conversationId,
        transactionContext,
      );
      if (conversation === null) {
        return 'skipped';
      }

      const analysis = await this.aiConversationService.findAnalysisByQuestion(
        candidate.questionUuid,
        transactionContext,
      );
      if (analysis === null || analysis.conversationId !== candidate.conversationId) {
        return 'skipped';
      }
      if (
        analysis.status !== AiMessageAnalysisStatus.PENDING ||
        analysis.answerMessageId !== null
      ) {
        return 'skipped';
      }

      const active = await this.executionLookup.findActiveExecutionByBizTarget({
        workflowType: AI_CONVERSATION_REPLY_WORKFLOW_TYPE,
        bizType: AI_CONVERSATION_BIZ_TYPE,
        bizSubKey: candidate.questionUuid,
        transactionContext,
        // 事务内当前读：不能以 MVCC 旧快照宣称「没有活动执行」
        forUpdate: true,
      });
      if (active !== null) {
        // 重试后的新执行仍在进行中：此时 analysis 的 PENDING 是「正在生成」，
        // 不能写失败（否则会挡掉新执行的回答写入）
        return 'skipped';
      }

      const latest = await this.executionLookup.findLatestExecutionByBizTarget({
        workflowType: AI_CONVERSATION_REPLY_WORKFLOW_TYPE,
        bizType: AI_CONVERSATION_BIZ_TYPE,
        bizSubKey: candidate.questionUuid,
        transactionContext,
      });
      if (latest === null || !TERMINAL_FAILED_STATUSES.includes(latest.status)) {
        return 'skipped';
      }

      const changed = await this.aiConversationService.markAnalysisFailed(
        {
          questionUuid: candidate.questionUuid,
          reason: `workflow_${latest.status.toLowerCase()}`,
        },
        transactionContext,
      );
      if (!changed) {
        return 'skipped';
      }
      this.logger.warn(
        {
          questionUuid: candidate.questionUuid,
          conversationId: candidate.conversationId,
          workflowId: latest.workflowId,
          workflowStatus: latest.status,
        },
        'AI 执行已终止但分析未收敛，已补写为可重试失败',
      );
      return 'settled';
    });
  }
}
