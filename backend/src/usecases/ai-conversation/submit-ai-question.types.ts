// src/usecases/ai-conversation/submit-ai-question.types.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { AiMessageAnalysisStatus } from '@app-types/models/ai-conversation.types';

import type { AiConversationDispatchStatus } from './ai-conversation-dispatch.types';

/**
 * 提交问题命令。
 *
 * `stage` 为本轮模型上下文（1–10 或 null）：S2 起随工作流上下文快照持久化，
 * 不再丢弃；重试由客户端重新传入（同一阶段语义）。
 */
export interface SubmitAiQuestionCommand {
  readonly session: UsecaseSession;
  readonly conversationId: number;
  readonly questionUuid: string;
  readonly question: string;
  readonly stage?: number | null;
}

/** 提交结果（受理事实 + 派发结果） */
export interface SubmitAiQuestionResult {
  readonly conversationId: number;
  readonly questionUuid: string;
  readonly status: AiMessageAnalysisStatus;
  readonly turnNo: number;
  readonly messageSeq: number;
  readonly contentVersion: number;
  /** 是否为同 UUID 同内容的幂等回放（未新增任何消息） */
  readonly replayed: boolean;
  /** 派发结果：入队／延后受理／派发失败（失败时本轮已标记 FAILED，可重试） */
  readonly dispatchStatus: AiConversationDispatchStatus;
}
