// src/usecases/ai-conversation/get-ai-admin-conversation-detail.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { AiMessageRole } from '@app-types/models/ai-conversation.types';
import { assertAiAdminConversationReadAccess } from '@core/ai/ai-conversation-read-access.policy';
import { AI_CONVERSATION_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';

import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { AiConversationQueryService } from '@src/modules/lithography/queries/ai-conversation.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

import {
  resolveAiAdminConversationIdentity,
  resolveAiAdminConversationScope,
} from './admin-ai-conversation-access';

/** 工程师昵称缺失回落（与管理员读侧同口径） */
const ENGINEER_NICKNAME_FALLBACK = '工程师';

/** 管理员只读单轮 */
export interface AiAdminConversationTurnView {
  readonly questionUuid: string;
  readonly turnNo: number | null;
  readonly analysisStatus: string | null;
  readonly failureReason: string | null;
  readonly analysisContentVersion: number | null;
  readonly question: AiAdminConversationMessageView | null;
  readonly answer: AiAdminConversationMessageView | null;
}

/** 管理员只读消息 */
export interface AiAdminConversationMessageView {
  readonly messageId: number;
  readonly messageSeq: number;
  readonly turnNo: number | null;
  readonly role: AiMessageRole;
  readonly text: string;
  readonly contentVersion: number;
  readonly createdAt: Date;
  readonly questionUuid: string | null;
}

/** 管理员只读会话详情 */
export interface AiAdminConversationDetailView {
  readonly conversationId: number;
  readonly requestId: number | null;
  readonly requestNo: string;
  readonly status: string;
  readonly contentVersion: number;
  readonly engineerNickname: string;
  readonly createdAt: Date;
  readonly turns: AiAdminConversationTurnView[];
}

/**
 * 管理员只读会话详情用例（R038-01，任务 05 · S4.1）
 *
 * - 核验会话公司 → 读取指定问答：一级跨公司，二级仅本公司；
 * - 直传外公司会话 ID 拒绝（与不存在同样返回 NOT_FOUND，不暴露存在性）；
 * - 只读：不取得编辑或提问权，不提供提问入口；
 * - 读取已保存内容，不重算模型；失败轮次如实带出失败原因。
 */
@Injectable()
export class GetAiAdminConversationDetailUsecase {
  constructor(
    private readonly aiConversationQueryService: AiConversationQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    private readonly accountQueryService: AccountQueryService,
  ) {}

  async execute(params: {
    session: UsecaseSession;
    conversationId: number;
  }): Promise<AiAdminConversationDetailView> {
    if (!Number.isInteger(params.conversationId) || params.conversationId <= 0) {
      throw new DomainError(AI_CONVERSATION_ERROR.INVALID_PARAMS, '会话标识必须是正整数', {
        conversationId: params.conversationId,
      });
    }

    const deps = {
      accountQueryService: this.accountQueryService,
      organizationContextService: this.organizationContextService,
    };
    // 管理员身份与范围（失败关闭：非管理员、等级非法、可信公司不可确定）
    const scope = await resolveAiAdminConversationScope({ session: params.session, deps });
    const admin = await resolveAiAdminConversationIdentity({ session: params.session, deps });

    const detail = await this.aiConversationQueryService.findAdminDetail({
      conversationId: params.conversationId,
      scope,
    });
    if (detail === null) {
      throw new DomainError(AI_CONVERSATION_ERROR.NOT_FOUND, '会话不存在或无权访问', {
        conversationId: params.conversationId,
      });
    }
    // 权威读取权复核（core 策略）：范围外的会话与不存在同口径
    assertAiAdminConversationReadAccess({
      admin,
      conversation: {
        ownerAccountId: detail.ownerAccountId,
        ownerOrganizationId: detail.ownerOrganizationId,
      },
    });

    const nicknames = await this.accountQueryService.findNicknamesByAccountIds([
      detail.ownerAccountId,
    ]);

    return {
      conversationId: detail.id,
      requestId: detail.requestId,
      requestNo: detail.requestNo,
      status: detail.status,
      contentVersion: detail.contentVersion,
      engineerNickname: nicknames.get(detail.ownerAccountId) ?? ENGINEER_NICKNAME_FALLBACK,
      createdAt: detail.createdAt,
      turns: buildTurns(detail),
    };
  }
}

/** 由消息与分析记录装配只读轮次（问题 / 回答 / 状态 / 失败原因） */
function buildTurns(detail: {
  messages: ReadonlyArray<AdminDetailMessageFact>;
  analyses: ReadonlyArray<AdminDetailAnalysisFact>;
}): AiAdminConversationTurnView[] {
  const messagesById = new Map(detail.messages.map((message) => [message.id, message]));
  const analysesByQuestion = new Map(
    detail.analyses.map((analysis) => [analysis.questionUuid, analysis]),
  );

  const turns = collectQuestionUuids(detail).map((questionUuid) =>
    buildTurn({
      questionUuid,
      analysesByQuestion,
      messagesById,
      messages: detail.messages,
    }),
  );
  return turns.sort((left, right) => (left.turnNo ?? 0) - (right.turnNo ?? 0));
}

/** 轮次问题标识集合：分析记录的问题 + 用户消息自带的稳定标识 */
function collectQuestionUuids(detail: {
  messages: ReadonlyArray<AdminDetailMessageFact>;
  analyses: ReadonlyArray<AdminDetailAnalysisFact>;
}): string[] {
  const questionUuids = new Set<string>();
  for (const analysis of detail.analyses) {
    questionUuids.add(analysis.questionUuid);
  }
  for (const message of detail.messages) {
    if (message.role === AiMessageRole.USER && message.questionUuid !== null) {
      questionUuids.add(message.questionUuid);
    }
  }
  return [...questionUuids];
}

/** 单轮装配：问题消息（有分析记录时按问题消息定位，否则按稳定标识回查） */
function buildTurn(input: {
  questionUuid: string;
  analysesByQuestion: Map<string, AdminDetailAnalysisFact>;
  messagesById: Map<number, AdminDetailMessageFact>;
  messages: ReadonlyArray<AdminDetailMessageFact>;
}): AiAdminConversationTurnView {
  const { questionUuid, analysesByQuestion, messagesById, messages } = input;
  const analysis = analysesByQuestion.get(questionUuid);
  const question = findQuestionMessage({ analysis, questionUuid, messagesById, messages });
  const answer = findAnswerMessage({ analysis, messagesById });
  return {
    questionUuid,
    turnNo: question?.turnNo ?? null,
    analysisStatus: analysis?.status ?? null,
    failureReason: analysis?.failureReason ?? null,
    analysisContentVersion: analysis?.contentVersion ?? null,
    question: question === null ? null : toMessageView(question),
    answer: answer === null ? null : toMessageView(answer),
  };
}

/** 定位问题消息：有分析记录按问题消息 ID，否则按用户消息的稳定标识回查 */
function findQuestionMessage(input: {
  analysis: AdminDetailAnalysisFact | undefined;
  questionUuid: string;
  messagesById: Map<number, AdminDetailMessageFact>;
  messages: ReadonlyArray<AdminDetailMessageFact>;
}): AdminDetailMessageFact | null {
  if (input.analysis) {
    return input.messagesById.get(input.analysis.questionMessageId) ?? null;
  }
  return (
    input.messages.find(
      (message) =>
        message.role === AiMessageRole.USER && message.questionUuid === input.questionUuid,
    ) ?? null
  );
}

/** 定位已保存的回答消息（未成功保存为空） */
function findAnswerMessage(input: {
  analysis: AdminDetailAnalysisFact | undefined;
  messagesById: Map<number, AdminDetailMessageFact>;
}): AdminDetailMessageFact | null {
  if (!input.analysis?.answerMessageId) {
    return null;
  }
  return input.messagesById.get(input.analysis.answerMessageId) ?? null;
}

/** 管理员只读消息事实 */
type AdminDetailMessageFact = {
  id: number;
  messageSeq: number;
  turnNo: number | null;
  role: AiMessageRole;
  contentText: string;
  contentVersion: number;
  createdAt: Date;
  questionUuid: string | null;
};

/** 管理员只读分析事实 */
type AdminDetailAnalysisFact = {
  questionUuid: string;
  questionMessageId: number;
  answerMessageId: number | null;
  status: string;
  failureReason: string | null;
  contentVersion: number;
};

function toMessageView(message: AdminDetailMessageFact): AiAdminConversationMessageView {
  return {
    messageId: message.id,
    messageSeq: message.messageSeq,
    turnNo: message.turnNo,
    role: message.role,
    text: message.contentText,
    contentVersion: message.contentVersion,
    createdAt: message.createdAt,
    questionUuid: message.questionUuid,
  };
}
