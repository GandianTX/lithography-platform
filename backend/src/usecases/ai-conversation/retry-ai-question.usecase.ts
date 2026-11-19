// src/usecases/ai-conversation/retry-ai-question.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  AiConversationDispatchStatus,
  AiConversationStatus,
  AiMessageAnalysisStatus,
} from '@app-types/models/ai-conversation.types';
import { isAiConversationStageValid } from '@core/ai/ai-conversation-request.policy';
import { isAiQuestionUuid, normalizeAiQuestionUuid } from '@core/ai/ai-question.policy';
import { AI_CONVERSATION_ERROR, DomainError } from '@core/common/errors/domain-error';
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
import type { SubmitAiQuestionResult } from './submit-ai-question.types';

export interface RetryAiQuestionCommand {
  readonly session: UsecaseSession;
  readonly conversationId: number;
  readonly questionUuid: string;
  readonly stage?: number | null;
}

/**
 * 重试用例（S2.1／S2.2）
 *
 * - 仅允许对**失败且无回答**的轮次重试；进行中/成功/已达上限一律拒绝，避免重复调用模型；
 * - 沿用同一问题 UUID（`requestId` 不变），只启动新的执行；
 * - 重置分析为 PENDING 与派发在同一提交序列内完成：重置失败（并发重试）即拒绝；
 * - 不新增用户问题、不推进内容版本。
 */
@Injectable()
export class RetryAiQuestionUsecase {
  constructor(
    private readonly aiConversationService: AiConversationService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    private readonly dispatchAiQuestionUsecase: DispatchAiQuestionUsecase,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: RetryAiQuestionCommand): Promise<SubmitAiQuestionResult> {
    assertEngineerAiPermission(command.session, '重试');

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

    const accepted = await this.transactionRunner.run(async (transactionContext) =>
      this.prepareRetry(command, questionUuid, transactionContext),
    );

    const dispatchResult = await this.dispatchAiQuestionUsecase.execute({
      session: command.session,
      conversationId: command.conversationId,
      questionUuid,
      questionText: accepted.questionText,
      turnNo: accepted.result.turnNo,
      messageSeq: accepted.result.messageSeq,
      contentVersion: accepted.result.contentVersion,
      stage,
    });

    if (dispatchResult.status === AiConversationDispatchStatus.FAILED) {
      return {
        ...accepted.result,
        status: AiMessageAnalysisStatus.FAILED,
        dispatchStatus: AiConversationDispatchStatus.FAILED,
      };
    }
    return { ...accepted.result, dispatchStatus: dispatchResult.status };
  }

  private async prepareRetry(
    command: RetryAiQuestionCommand,
    questionUuid: string,
    transactionContext: PersistenceTransactionContext,
  ): Promise<{ readonly result: SubmitAiQuestionResult; readonly questionText: string }> {
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
      throw new DomainError(AI_CONVERSATION_ERROR.NOT_FOUND, 'AI 会话不存在或无权重试', {
        conversationId: command.conversationId,
      });
    }
    this.assertOwnerAndActive(command.session.accountId, conversation);

    const [analysis, question] = await Promise.all([
      this.aiConversationService.findAnalysisByQuestion(questionUuid, transactionContext),
      this.aiConversationService.findQuestionByUuid(questionUuid, transactionContext),
    ]);
    if (
      !analysis ||
      !question ||
      analysis.conversationId !== command.conversationId ||
      question.conversationId !== command.conversationId
    ) {
      throw new DomainError(AI_CONVERSATION_ERROR.NOT_FOUND, '该问题不存在或不属于该会话', {
        conversationId: command.conversationId,
        questionUuid,
      });
    }
    if (analysis.status !== AiMessageAnalysisStatus.FAILED || analysis.answerMessageId !== null) {
      throw new DomainError(
        AI_CONVERSATION_ERROR.RETRY_NOT_ALLOWED,
        '仅失败且未保存回答的轮次可以重试',
        { conversationId: command.conversationId, questionUuid, status: analysis.status },
      );
    }

    const reset = await this.aiConversationService.resetAnalysisForRetry(
      { questionUuid },
      transactionContext,
    );
    if (!reset) {
      throw new DomainError(
        AI_CONVERSATION_ERROR.RETRY_NOT_ALLOWED,
        '该轮次状态已变化（可能已重试），请刷新后再试',
        { conversationId: command.conversationId, questionUuid },
      );
    }

    return {
      questionText: question.contentText,
      result: {
        conversationId: command.conversationId,
        questionUuid,
        status: AiMessageAnalysisStatus.PENDING,
        turnNo: question.turnNo ?? 0,
        messageSeq: question.messageSeq,
        contentVersion: analysis.contentVersion,
        replayed: false,
        dispatchStatus: AiConversationDispatchStatus.DEFERRED,
      },
    };
  }

  private assertOwnerAndActive(accountId: number, conversation: AiConversationLockSnapshot): void {
    if (conversation.engineerAccountId !== accountId) {
      throw new DomainError(AI_CONVERSATION_ERROR.NOT_FOUND, 'AI 会话不存在或无权重试', {
        conversationId: conversation.id,
      });
    }
    if (conversation.status !== AiConversationStatus.ACTIVE) {
      throw new DomainError(AI_CONVERSATION_ERROR.CONVERSATION_NOT_ACTIVE, '会话已结束，无法重试', {
        conversationId: conversation.id,
        status: conversation.status,
      });
    }
  }
}
