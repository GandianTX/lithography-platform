// src/usecases/ai-conversation/submit-ai-question.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  AiConversationDispatchStatus,
  AiConversationStatus,
  AiMessageAnalysisStatus,
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
import { Inject, Injectable } from '@nestjs/common';
import { AiConversationService } from '@src/modules/lithography/ai-conversation.service';
import type { AiConversationLockSnapshot } from '@src/modules/lithography/ai-conversation.types';
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
import type { SubmitAiQuestionCommand, SubmitAiQuestionResult } from './submit-ai-question.types';

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
  constructor(
    private readonly aiConversationService: AiConversationService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
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

    let accepted: SubmitAiQuestionResult;
    try {
      accepted = await this.transactionRunner.run(async (transactionContext) =>
        this.submitWithinTransaction(command, questionUuid, normalizedText, transactionContext),
      );
    } catch (error) {
      if (isDomainError(error) && error.code === AI_CONVERSATION_ERROR.QUESTION_CONFLICT) {
        // 并发同 UUID：本事务已回滚，回读先到者的既有事实
        return this.resolveConflictByReplay(command, questionUuid, normalizedText);
      }
      throw error;
    }

    if (accepted.replayed) {
      return accepted;
    }

    return await this.dispatchAcceptedQuestion({
      command,
      accepted,
      questionUuid,
      normalizedText,
      stage,
    });
  }

  /** 受理提交后派发（S2.1）：派发结果回填到受理事实，失败时本轮转为可重试失败 */
  private async dispatchAcceptedQuestion(input: {
    readonly command: SubmitAiQuestionCommand;
    readonly accepted: SubmitAiQuestionResult;
    readonly questionUuid: string;
    readonly normalizedText: string;
    readonly stage: number | null;
  }): Promise<SubmitAiQuestionResult> {
    const { command, accepted, questionUuid, normalizedText, stage } = input;

    const dispatchResult = await this.dispatchAiQuestionUsecase.execute({
      session: command.session,
      conversationId: command.conversationId,
      questionUuid,
      questionText: normalizedText,
      turnNo: accepted.turnNo,
      messageSeq: accepted.messageSeq,
      contentVersion: accepted.contentVersion,
      stage,
    });

    if (dispatchResult.status === AiConversationDispatchStatus.FAILED) {
      return {
        ...accepted,
        status: AiMessageAnalysisStatus.FAILED,
        dispatchStatus: AiConversationDispatchStatus.FAILED,
      };
    }
    return { ...accepted, dispatchStatus: dispatchResult.status };
  }

  private async submitWithinTransaction(
    command: SubmitAiQuestionCommand,
    questionUuid: string,
    normalizedText: string,
    transactionContext: PersistenceTransactionContext,
  ): Promise<SubmitAiQuestionResult> {
    await resolveEngineerTrustedOrganization({
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
    this.assertConversationWritableBy(command.session.accountId, conversation);

    const existing = await this.aiConversationService.findQuestionByUuid(
      questionUuid,
      transactionContext,
    );
    if (existing) {
      return this.resolveExistingQuestion(existing, command.conversationId, normalizedText);
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

    return {
      conversationId: command.conversationId,
      questionUuid,
      status: analysis.status,
      turnNo: nextTurnNo,
      messageSeq,
      contentVersion: analysis.contentVersion,
      replayed: false,
      // 事务内尚未派发：对外由 dispatchAcceptedQuestion 覆盖为真实结果
      dispatchStatus: AiConversationDispatchStatus.DEFERRED,
    };
  }

  /** 写权限仅归会话所有者；同公司可读不等于可续写 */
  private assertConversationWritableBy(
    accountId: number,
    conversation: AiConversationLockSnapshot,
  ): void {
    if (conversation.engineerAccountId !== accountId) {
      throw new DomainError(AI_CONVERSATION_ERROR.NOT_FOUND, 'AI 会话不存在或无权提问', {
        conversationId: conversation.id,
      });
    }
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
