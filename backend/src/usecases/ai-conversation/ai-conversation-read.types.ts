// src/usecases/ai-conversation/ai-conversation-read.types.ts

import type {
  AiConversationStatus,
  AiMessageAnalysisStatus,
  AiMessageRole,
} from '@app-types/models/ai-conversation.types';

/** 逐条消息（详情读模型，含顺序与内容版本） */
export interface AiConversationMessageResult {
  readonly messageId: number;
  readonly messageSeq: number;
  readonly turnNo: number | null;
  readonly role: AiMessageRole;
  readonly questionUuid: string | null;
  readonly text: string;
  readonly contentVersion: number;
  readonly createdAt: Date;
}

/** 单轮问答（问题 / 已保存回答 / 分析状态三者按 question_uuid 对齐） */
export interface AiConversationTurnResult {
  readonly questionUuid: string;
  readonly turnNo: number | null;
  readonly question: AiConversationMessageResult | null;
  readonly answer: AiConversationMessageResult | null;
  readonly analysisStatus: AiMessageAnalysisStatus | null;
  readonly failureReason: string | null;
  readonly analysisContentVersion: number | null;
  readonly completedAt: Date | null;
}

/** 会话详情（R036-02） */
export interface MyAiConversationDetailResult {
  readonly id: number;
  readonly requestId: number | null;
  readonly requestNo: string;
  readonly status: AiConversationStatus;
  readonly contentVersion: number;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  readonly messages: ReadonlyArray<AiConversationMessageResult>;
  readonly turns: ReadonlyArray<AiConversationTurnResult>;
}

/** 本轮状态查询结果（R036 配套查询：受理情况、生成状态、失败原因或正文） */
export interface AiQuestionStatusResult {
  readonly conversationId: number;
  readonly questionUuid: string;
  readonly status: AiMessageAnalysisStatus;
  readonly failureReason: string | null;
  readonly contentVersion: number;
  readonly turnNo: number | null;
  readonly questionText: string;
  readonly answer: AiConversationMessageResult | null;
  /** 短时图形快照（仅成功轮且通道仍有效；过期/缺失为 null） */
  readonly visualization: unknown;
}
