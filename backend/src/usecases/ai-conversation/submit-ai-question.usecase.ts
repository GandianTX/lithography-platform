// src/usecases/ai-conversation/submit-ai-question.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  AiConversationDispatchStatus,
  AiConversationStatus,
} from '@app-types/models/ai-conversation.types';
import { isAiConversationStageValid } from '@core/ai/ai-conversation-request.policy';
import {
  canStartNextTurn,
  isAiQuestionTextLengthValid,
  isAiQuestionUuid,
  normalizeAiQuestionText,
  normalizeAiQuestionUuid,
} from '@core/ai/ai-question.policy';
import {
  AI_CONVERSATION_ERROR,
  DomainError,
  isDomainError,
} from '@core/common/errors/domain-error';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AiConversationService } from '@src/modules/lithography/ai-conversation.service';
import type { AiConversationLockSnapshot } from '@src/modules/lithography/ai-conversation.types';
import { RepairRequestQueryService } from '@src/modules/lithography/queries/repair-request.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { DispatchAiQuestionUsecase } from './dispatch-ai-question.usecase';
import {
  assertEngineerAiPermission,
  resolveEngineerTrustedOrganization,
} from './engineer-ai-access';
import { assertEngineerConversationWritable } from './engineer-conversation-access.guard';
import type { SubmitAiQuestionCommand, SubmitAiQuestionResult } from './submit-ai-question.types';

/** 受理事务的返回值：对外结果 + 事务内已落库的执行事实（Q01） */
interface SubmitAcceptance {
  readonly result: SubmitAiQuestionResult;
  readonly workflowId: string | null;
  readonly workflowDisposition: 'PREPARED' | 'EXISTING_ACTIVE';
}

/**
 * 提交 AI 问题用例（R034-01／R034-02／A05-02）
 *
 * 关键不变量：
 * 1. **同事务受理**：用户问题、分析记录（PENDING）与会话内容版本在同一事务内提交，
 *    不存在「只存问题不存分析」或反之的半受理状态；
 * 2. **稳定 UUID 幂等**：同 UUID + 同规范化正文 → 返回既有分析与轮次，不新增消息；
 *    同 UUID + 异正文 → `QUESTION_CONFLICT`，绝不静默返回旧答案；
 * 3. **并发安全**：会话行锁（`pessimistic_write`）串行化轮次计算；
 *    唯一键冲突（并发同 UUID）回滚后走回读路径，最终只有一条用户问题；
 * 4. **写权限只归所有者**：非会话所有者的工程师即使同公司可读，也不能续写；
 * 5. **不触发模型**：本用例只做受理，派发执行由 S2 接入。
 */
@Injectable()
export class SubmitAiQuestionUsecase {
  private readonly logger = new Logger(SubmitAiQuestionUsecase.name);

  constructor(
    private readonly aiConversationService: AiConversationService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    private readonly repairRequestQueryService: RepairRequestQueryService,
    private readonly dispatchAiQuestionUsecase: DispatchAiQuestionUsecase,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: SubmitAiQuestionCommand): Promise<SubmitAiQuestionResult> {
    assertEngineerAiPermission(command.session, '提问');

    if (!Number.isInteger(command.conversationId) || command.conversationId <= 0) {
      throw new DomainError(AI_CONVERSATION_ERROR.INVALID_PARAMS, '会话 ID 无效', {
        conversationId: command.conversationId,
      });
    }

    const questionUuid = normalizeAiQuestionUuid(command.questionUuid);
    if (!isAiQuestionUuid(questionUuid)) {
      throw new DomainError(AI_CONVERSATION_ERROR.INVALID_PARAMS, '问题标识必须是稳定的 UUID v4', {
        questionUuid: command.questionUuid,
      });
    }

    const stage = command.stage === undefined ? null : command.stage;
    if (!isAiConversationStageValid(stage)) {
      throw new DomainError(AI_CONVERSATION_ERROR.INVALID_PARAMS, '阶段必须在 1–10 之间', {
        stage,
      });
    }

    const normalizedText = normalizeAiQuestionText(command.question);
    if (!isAiQuestionTextLengthValid(normalizedText)) {
      throw new DomainError(
        AI_CONVERSATION_ERROR.INVALID_PARAMS,
        '问题正文长度必须在 1–2000 字之间',
        {
          conversationId: command.conversationId,
          length: normalizedText.length,
        },
      );
    }

    let accepted: SubmitAcceptance;
    try {
      accepted = await this.transactionRunner.run(async (transactionContext) =>
        this.submitWithinTransaction(
          command,
          questionUuid,
          normalizedText,
          stage,
          transactionContext,
        ),
      );
    } catch (error) {
      if (isDomainError(error) && error.code === AI_CONVERSATION_ERROR.QUESTION_CONFLICT) {
        // 并发同 UUID：本事务已回滚，回读先到者的既有事实
        return this.resolveConflictByReplay(command, questionUuid, normalizedText);
      }
      throw error;
    }

    if (accepted.result.replayed) {
      return accepted.result;
    }

    return await this.admitAcceptedQuestion(accepted);
  }

  /**
   * 受理事务提交后投递（Q01）：只投递事务内已落库的执行事实。
   *
   * 投递失败不再把本轮判成失败——数据库里的待准入事实会被正式 housekeeping 重投，
   * 因此不会出现「已受理但既无执行又不可重试」的孤儿 PENDING。
   */
  private async admitAcceptedQuestion(accepted: SubmitAcceptance): Promise<SubmitAiQuestionResult> {
    if (accepted.workflowId === null || accepted.workflowDisposition === 'EXISTING_ACTIVE') {
      return { ...accepted.result, dispatchStatus: AiConversationDispatchStatus.DEFERRED };
    }
    const dispatchResult = await this.dispatchAiQuestionUsecase.admitPrepared({
      workflowId: accepted.workflowId,
    });
    return { ...accepted.result, dispatchStatus: dispatchResult.status };
  }

  private async submitWithinTransaction(
    command: SubmitAiQuestionCommand,
    questionUuid: string,
    normalizedText: string,
    stage: number | null,
    transactionContext: PersistenceTransactionContext,
  ): Promise<SubmitAcceptance> {
    // F01：当前可信公司必须真正用于判定，不能只解析后丢弃
    const organizationId = await resolveEngineerTrustedOrganization({
      organizationContextService: this.organizationContextService,
      accountId: command.session.accountId,
      transactionContext,
    });

    const conversation = await this.aiConversationService.lockConversationForWrite(
      command.conversationId,
      transactionContext,
    );
    if (!conversation) {
      throw new DomainError(AI_CONVERSATION_ERROR.NOT_FOUND, 'AI 会话不存在或无权提问', {
        conversationId: command.conversationId,
      });
    }
    await assertEngineerConversationWritable({
      conversation,
      accountId: command.session.accountId,
      organizationId,
      repairRequestQueryService: this.repairRequestQueryService,
      transactionContext,
      actionLabel: '提问',
    });
    this.assertConversationActive(conversation);

    const existing = await this.aiConversationService.findQuestionByUuid(
      questionUuid,
      transactionContext,
    );
    if (existing) {
      return {
        result: await this.resolveExistingQuestion(
          existing,
          command.conversationId,
          normalizedText,
        ),
        workflowId: null,
        workflowDisposition: 'EXISTING_ACTIVE',
      };
    }

    const { maxMessageSeq, maxTurnNo } = await this.aiConversationService.getSequenceFacts(
      command.conversationId,
      transactionContext,
    );
    const nextTurnNo = maxTurnNo + 1;
    if (!canStartNextTurn(nextTurnNo)) {
      throw new DomainError(
        AI_CONVERSATION_ERROR.TURN_LIMIT_REACHED,
        '当前会话已达到 100 轮上限，请另开新会话',
        { conversationId: command.conversationId, turnNo: nextTurnNo },
      );
    }

    const messageSeq = maxMessageSeq + 1;
    // 先推进会话版本，再以该版本写入本轮消息与分析：
    // 同一轮的问题消息、分析记录与会话版本号必须一致，否则「逐条消息版本」无意义。
    const contentVersion = await this.aiConversationService.bumpContentVersion(
      command.conversationId,
      transactionContext,
    );

    const questionMessage = await this.aiConversationService.insertUserMessage(
      {
        conversationId: command.conversationId,
        questionUuid,
        messageSeq,
        turnNo: nextTurnNo,
        contentText: normalizedText,
        contentVersion,
      },
      transactionContext,
    );

    const analysis = await this.aiConversationService.insertAnalysis(
      {
        questionUuid,
        conversationId: command.conversationId,
        questionMessageId: questionMessage.id,
        contentVersion,
      },
      transactionContext,
    );

    // Q01／B2：执行事实与问题／分析在同一事务内落下，
    // 提交后再投递；任一步失败整体回滚，不存在「已受理但无执行」的窗口
    const prepared = await this.dispatchAiQuestionUsecase.prepareWithinTransaction(
      {
        session: command.session,
        conversationId: command.conversationId,
        questionUuid,
        questionText: normalizedText,
        turnNo: nextTurnNo,
        messageSeq,
        contentVersion,
        stage,
      },
      transactionContext,
    );

    return {
      result: {
        conversationId: command.conversationId,
        questionUuid,
        status: analysis.status,
        turnNo: nextTurnNo,
        messageSeq,
        contentVersion: analysis.contentVersion,
        replayed: false,
        // 事务内尚未投递：对外由 admitAcceptedQuestion 覆盖为真实结果
        dispatchStatus: AiConversationDispatchStatus.DEFERRED,
      },
      workflowId: prepared.workflowId,
      workflowDisposition: prepared.status,
    };
  }

  /** 会话状态：写权限与资源复核已由 guard 完成，这里只判 ACTIVE */
  private assertConversationActive(conversation: AiConversationLockSnapshot): void {
    if (conversation.status !== AiConversationStatus.ACTIVE) {
      throw new DomainError(
        AI_CONVERSATION_ERROR.CONVERSATION_NOT_ACTIVE,
        '会话已结束，无法继续提问',
        { conversationId: conversation.id, status: conversation.status },
      );
    }
  }

  /** 事务内命中既有问题：同内容幂等回放，异内容拒绝 */
  private async resolveExistingQuestion(
    existing: { conversationId: number; questionUuid: string | null; contentText: string },
    conversationId: number,
    normalizedText: string,
  ): Promise<SubmitAiQuestionResult> {
    if (existing.conversationId !== conversationId || existing.contentText !== normalizedText) {
      throw new DomainError(
        AI_CONVERSATION_ERROR.QUESTION_CONFLICT,
        '该问题标识已用于其他内容，请使用新的问题标识',
        { conversationId, questionUuid: existing.questionUuid },
      );
    }
    return this.toReplayResult(conversationId, existing.questionUuid ?? '');
  }

  /** 唯一键冲突后的回读：先到者事实为准；仍不一致则按冲突拒绝 */
  private async resolveConflictByReplay(
    command: SubmitAiQuestionCommand,
    questionUuid: string,
    normalizedText: string,
  ): Promise<SubmitAiQuestionResult> {
    const existing = await this.aiConversationService.findQuestionByUuid(questionUuid);
    if (
      !existing ||
      existing.conversationId !== command.conversationId ||
      existing.contentText !== normalizedText
    ) {
      throw new DomainError(
        AI_CONVERSATION_ERROR.QUESTION_CONFLICT,
        '该问题标识已用于其他内容，请使用新的问题标识',
        { conversationId: command.conversationId, questionUuid },
      );
    }
    return this.toReplayResult(command.conversationId, questionUuid);
  }

  private async toReplayResult(
    conversationId: number,
    questionUuid: string,
  ): Promise<SubmitAiQuestionResult> {
    const [question, analysis] = await Promise.all([
      this.aiConversationService.findQuestionByUuid(questionUuid),
      this.aiConversationService.findAnalysisByQuestion(questionUuid),
    ]);
    if (!question || !analysis || question.conversationId !== conversationId) {
      throw new DomainError(
        AI_CONVERSATION_ERROR.SUBMIT_FAILED,
        '问题受理状态读取失败，请重新查询本轮状态',
        { conversationId, questionUuid },
      );
    }
    return {
      conversationId,
      questionUuid,
      status: analysis.status,
      turnNo: question.turnNo ?? 0,
      messageSeq: question.messageSeq,
      contentVersion: analysis.contentVersion,
      replayed: true,
      // 幂等回放不重复派发（已有执行在途或已终态）
      dispatchStatus: AiConversationDispatchStatus.DEFERRED,
    };
  }
}
