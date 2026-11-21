// src/usecases/ai-conversation/get-my-ai-conversation-detail.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { AiMessageRole } from '@app-types/models/ai-conversation.types';
import { AI_CONVERSATION_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import type {
  AiMessageAnalysisSnapshot,
  AiMessageQueryResult,
} from '@src/modules/lithography/ai-conversation.types';
import { AiConversationQueryService } from '@src/modules/lithography/queries/ai-conversation.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type {
  AiConversationMessageResult,
  AiConversationTurnResult,
  MyAiConversationDetailResult,
} from './ai-conversation-read.types';
import { assertEngineerAiPermission } from './engineer-ai-access';

/** 组装期可写视图（对外仍暴露只读结果类型） */
type MutableTurn = {
  -readonly [K in keyof AiConversationTurnResult]: AiConversationTurnResult[K];
};

/**
 * 工程师查询单个 AI 会话详情用例（R036-02）
 *
 * - 可见性由读侧同一条件保证；不可见与不存在统一 `NOT_FOUND`，避免探测他人会话；
 * - 按 `question_uuid` 把问题、已保存回答、分析状态对齐为「轮」，
 *   未成功的轮次只返回状态与失败原因，绝不伪造或补写回答正文；
 * - 只读：不触发模型调用，不改变任何状态。
 */
@Injectable()
export class GetMyAiConversationDetailUsecase {
  constructor(
    private readonly aiConversationQueryService: AiConversationQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(params: {
    session: UsecaseSession;
    conversationId: number;
  }): Promise<MyAiConversationDetailResult> {
    assertEngineerAiPermission(params.session, '查看');

    if (!Number.isInteger(params.conversationId) || params.conversationId <= 0) {
      throw new DomainError(AI_CONVERSATION_ERROR.INVALID_PARAMS, '会话 ID 无效', {
        conversationId: params.conversationId,
      });
    }

    const organizationFact = await this.organizationContextService.tryResolveForAccount({
      accountId: params.session.accountId,
    });

    const detail = await this.aiConversationQueryService.findVisibleDetail({
      conversationId: params.conversationId,
      viewer: {
        accountId: params.session.accountId,
        organizationId: organizationFact?.organizationId ?? null,
      },
    });
    if (!detail) {
      throw new DomainError(AI_CONVERSATION_ERROR.NOT_FOUND, 'AI 会话不存在或无权查看', {
        conversationId: params.conversationId,
      });
    }

    const messages = detail.messages.map((message) => this.toMessageResult(message));

    return {
      id: detail.id,
      requestId: detail.requestId,
      requestNo: detail.requestNo,
      status: detail.status,
      contentVersion: detail.contentVersion,
      createdAt: detail.createdAt,
      completedAt: detail.completedAt,
      messages,
      turns: this.buildTurns(messages, detail.analyses),
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

  /**
   * 组装轮次：
   * 1. 每个带 `question_uuid` 的 USER 消息开启一轮（顺序沿用 message_seq）；
   * 2. ASSISTANT 消息优先挂到分析记录声明的 `answer_message_id`，
   *    否则挂到同 `turn_no` 的最近一轮（历史数据兼容）；
   * 3. 分析状态按 `question_uuid` 关联；无分析记录时状态为 null（不猜默认值）。
   */
  private buildTurns(
    messages: ReadonlyArray<AiConversationMessageResult>,
    analyses: ReadonlyArray<AiMessageAnalysisSnapshot>,
  ): AiConversationTurnResult[] {
    const analysisByQuestion = new Map(
      analyses.map((analysis) => [analysis.questionUuid, analysis]),
    );
    const turnByQuestion = new Map<string, MutableTurn>();
    const turnByMessageId = new Map<number, MutableTurn>();
    const orderedTurns: MutableTurn[] = [];

    for (const message of messages) {
      const turn = this.createTurnFromQuestion(message, analysisByQuestion);
      if (!turn) {
        continue;
      }
      orderedTurns.push(turn);
      turnByQuestion.set(turn.questionUuid, turn);
      turnByMessageId.set(message.messageId, turn);
    }

    this.registerAnswerOwners(analyses, turnByQuestion, turnByMessageId);
    this.attachAnswerMessages(messages, orderedTurns, turnByMessageId);

    return orderedTurns;
  }

  /** 用户消息 → 轮次（无 question_uuid 的历史消息不开启轮次） */
  private createTurnFromQuestion(
    message: AiConversationMessageResult,
    analysisByQuestion: ReadonlyMap<string, AiMessageAnalysisSnapshot>,
  ): MutableTurn | null {
    if (message.role !== AiMessageRole.USER || message.questionUuid === null) {
      return null;
    }
    const analysis = analysisByQuestion.get(message.questionUuid);
    return {
      questionUuid: message.questionUuid,
      turnNo: message.turnNo,
      question: message,
      answer: null,
      analysisStatus: analysis?.status ?? null,
      failureReason: analysis?.failureReason ?? null,
      analysisContentVersion: analysis?.contentVersion ?? null,
      completedAt: analysis?.completedAt ?? null,
    };
  }

  /** 按分析记录声明的 answer_message_id 把回答消息归属到具体轮次 */
  private registerAnswerOwners(
    analyses: ReadonlyArray<AiMessageAnalysisSnapshot>,
    turnByQuestion: ReadonlyMap<string, MutableTurn>,
    turnByMessageId: Map<number, MutableTurn>,
  ): void {
    for (const analysis of analyses) {
      const turn = turnByQuestion.get(analysis.questionUuid);
      if (turn && analysis.answerMessageId !== null) {
        turnByMessageId.set(analysis.answerMessageId, turn);
      }
    }
  }

  /** 回答消息挂载：优先声明归属，其次同 turn_no 的最近一轮 */
  private attachAnswerMessages(
    messages: ReadonlyArray<AiConversationMessageResult>,
    orderedTurns: ReadonlyArray<MutableTurn>,
    turnByMessageId: ReadonlyMap<number, MutableTurn>,
  ): void {
    for (const message of messages) {
      if (message.role !== AiMessageRole.ASSISTANT) {
        continue;
      }
      const target =
        turnByMessageId.get(message.messageId) ??
        this.findLatestTurnByTurnNo(orderedTurns, message.turnNo);
      if (target) {
        target.answer = message;
      }
    }
  }

  private findLatestTurnByTurnNo(
    turns: ReadonlyArray<MutableTurn>,
    turnNo: number | null,
  ): MutableTurn | null {
    if (turnNo === null) {
      return null;
    }
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (turns[index].turnNo === turnNo) {
        return turns[index];
      }
    }
    return null;
  }
}
