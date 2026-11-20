// src/usecases/ai-conversation/get-ai-question-status.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { AiMessageAnalysisStatus } from '@app-types/models/ai-conversation.types';
import { isAiQuestionUuid, normalizeAiQuestionUuid } from '@core/ai/ai-question.policy';
import { AI_CONVERSATION_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import {
  AI_CONVERSATION_VISUALIZATION_STORE,
  type AiConversationVisualizationStore,
} from '@src/infrastructure/ai/conversation/ai-conversation-visualization.store';
import type { AiMessageQueryResult } from '@src/modules/lithography/ai-conversation.types';
import { AiConversationQueryService } from '@src/modules/lithography/queries/ai-conversation.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type {
  AiConversationMessageResult,
  AiQuestionStatusResult,
} from './ai-conversation-read.types';
import { assertEngineerAiPermission } from './engineer-ai-access';

/**
 * 查询单轮问题受理状态用例（R034「结果未知先查原问题」）
 *
 * 纯只读：不触发投递、不触发模型调用、不重算正文、不写 analysis 状态。
 *
 * 2026-11-20 纠偏：此前本用例在读状态时调用恢复编排（可能重新投递任务并写 analysis），
 * 使「查询」隐含写入与投递能力，与「状态查询只读、恢复由正式运行入口负责」的约定冲突。
 * 现在未终态轮次的恢复由 Worker 生命周期的正式扫描负责：
 * - 准入／投递重试与准入超时收敛：`RunAiWorkflowHousekeepingUsecase`；
 * - 执行终止后的 analysis 补写：`AiQuestionAnalysisSettlementService`。
 *
 * - 先做会话可见性校验，再按 `question_uuid` 读取分析事实；
 * - 成功时返回已保存正文与内容版本；未成功时返回状态与失败原因。
 */
@Injectable()
export class GetAiQuestionStatusUsecase {
  constructor(
    private readonly aiConversationQueryService: AiConversationQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    @Inject(AI_CONVERSATION_VISUALIZATION_STORE)
    private readonly visualizationStore: AiConversationVisualizationStore,
  ) {}

  async execute(params: {
    session: UsecaseSession;
    conversationId: number;
    questionUuid: string;
  }): Promise<AiQuestionStatusResult> {
    assertEngineerAiPermission(params.session, '查询');

    if (!Number.isInteger(params.conversationId) || params.conversationId <= 0) {
      throw new DomainError(AI_CONVERSATION_ERROR.INVALID_PARAMS, '会话 ID 无效', {
        conversationId: params.conversationId,
      });
    }
    const questionUuid = normalizeAiQuestionUuid(params.questionUuid);
    if (!isAiQuestionUuid(questionUuid)) {
      throw new DomainError(AI_CONVERSATION_ERROR.INVALID_PARAMS, '问题标识必须是稳定的 UUID v4', {
        questionUuid: params.questionUuid,
      });
    }

    const organizationFact = await this.organizationContextService.tryResolveForAccount({
      accountId: params.session.accountId,
    });
    const viewer = {
      accountId: params.session.accountId,
      organizationId: organizationFact?.organizationId ?? null,
    };

    const header = await this.aiConversationQueryService.findVisibleHeader({
      conversationId: params.conversationId,
      viewer,
    });
    if (!header) {
      throw new DomainError(AI_CONVERSATION_ERROR.NOT_FOUND, 'AI 会话不存在或无权查看', {
        conversationId: params.conversationId,
      });
    }

    const analysis = await this.aiConversationQueryService.findAnalysisByQuestion({
      conversationId: params.conversationId,
      questionUuid,
    });
    if (!analysis) {
      throw new DomainError(AI_CONVERSATION_ERROR.NOT_FOUND, '该问题不存在或不属于该会话', {
        conversationId: params.conversationId,
        questionUuid,
      });
    }

    const [question, answer] = await Promise.all([
      this.aiConversationQueryService.findQuestionMessage({
        conversationId: params.conversationId,
        questionUuid,
      }),
      this.aiConversationQueryService.findAnswerMessage(analysis.answerMessageId),
    ]);

    // 图形只从短时通道读取：非成功轮不读，过期/缺失返回 null（正文照常）
    const visualization =
      analysis.status === AiMessageAnalysisStatus.SUCCEEDED && analysis.answerMessageId !== null
        ? await this.visualizationStore.load({
            conversationId: params.conversationId,
            questionUuid,
            contentVersion: analysis.contentVersion,
          })
        : null;

    return {
      conversationId: params.conversationId,
      questionUuid,
      status: analysis.status,
      failureReason: analysis.failureReason,
      contentVersion: analysis.contentVersion,
      turnNo: question?.turnNo ?? null,
      questionText: question?.contentText ?? '',
      answer: answer ? this.toMessageResult(answer) : null,
      visualization,
    };
  }

  private toMessageResult(message: AiMessageQueryResult): AiConversationMessageResult {
    return {
      messageId: message.id,
      messageSeq: message.messageSeq,
      turnNo: message.turnNo,
      role: message.role,
      questionUuid: message.questionUuid,
      text: message.contentText,
      contentVersion: message.contentVersion,
      createdAt: message.createdAt,
    };
  }
}
