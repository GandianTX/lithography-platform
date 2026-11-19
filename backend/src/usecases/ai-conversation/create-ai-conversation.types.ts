// src/usecases/ai-conversation/create-ai-conversation.types.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { AiConversationStatus } from '@app-types/models/ai-conversation.types';

/** 创建 AI 会话命令（客户端的公司/工程师字段不参与，只认会话与数据库事实） */
export interface CreateAiConversationCommand {
  readonly session: UsecaseSession;
  /** 关联工单 ID；null 表示独立会话 */
  readonly requestId: number | null;
}

/** 创建结果（会话头最小事实） */
export interface CreateAiConversationResult {
  readonly id: number;
  readonly requestId: number | null;
  readonly requestNo: string;
  readonly status: AiConversationStatus;
  readonly contentVersion: number;
  readonly createdAt: Date;
}
