// src/usecases/ai-conversation/get-ai-conversation-evaluation-scope.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { AI_CONVERSATION_ERROR, DomainError } from '@core/common/errors/domain-error';
import { isAiExportContentVersionValid } from '@src/core/ai/ai-conversation-export.policy';
import { Injectable } from '@nestjs/common';

import { AiConversationSnapshotService } from './ai-conversation-snapshot.service';

/** 评价范围内的一条有效回复 */
export interface AiConversationEvaluationReplyView {
  readonly messageId: number;
  readonly messageSeq: number;
  readonly turnNo: number | null;
  readonly contentVersion: number;
  /** 该轮分析状态（固定范围内如实标记） */
  readonly analysisStatus: string;
  readonly text: string;
  readonly createdAt: string;
}

/** 关联会话的固定评价范围（交付 06 评价链） */
export interface AiConversationEvaluationScopeView {
  readonly conversationId: number;
  readonly requestId: number | null;
  readonly requestNo: string | null;
  /** 固定的内容版本（选定版本与当时会话版本取小） */
  readonly contentVersion: number;
  /** 固定范围内的最后消息序号（消息截止点） */
  readonly lastMessageSeq: number;
  /** 有效回复（范围内已成功保存的回答，按消息序号升序） */
  readonly replies: ReadonlyArray<AiConversationEvaluationReplyView>;
}

/**
 * 关联会话固定评价范围用例（任务 05 · S4.3）
 *
 * 交付 06 评价链的读取契约：
 * - 固定消息截止与版本：调用方显式选定内容版本，本次读取范围不再随追加消息漂移；
 * - 有效回复：范围内已成功保存的回答（含轮次与版本），失败与未完成轮次不计入有效回复；
 * - 读取权与导出、只读详情复用同一边界（工程师本人／本公司工单；管理员一级跨公司、
 *   二级本公司），直传外公司会话 ID 拒绝；
 * - 06 真实评价链未就绪，本次仅交付契约与样例，联调待验证。
 */
@Injectable()
export class GetAiConversationEvaluationScopeUsecase {
  constructor(private readonly snapshotService: AiConversationSnapshotService) {}

  async execute(params: {
    session: UsecaseSession;
    conversationId: number;
    contentVersion: number;
  }): Promise<AiConversationEvaluationScopeView> {
    if (!Number.isInteger(params.conversationId) || params.conversationId <= 0) {
      throw new DomainError(AI_CONVERSATION_ERROR.INVALID_PARAMS, '会话标识必须是正整数', {
        conversationId: params.conversationId,
      });
    }
    if (!isAiExportContentVersionValid(params.contentVersion)) {
      throw new DomainError(AI_CONVERSATION_ERROR.INVALID_PARAMS, '内容版本必须是正整数', {
        contentVersion: params.contentVersion,
      });
    }

    const snapshot = await this.snapshotService.resolveReadableSnapshot({
      session: params.session,
      conversationId: params.conversationId,
      contentVersion: params.contentVersion,
      actionLabel: '读取评价范围',
    });

    const replies = snapshot.messages
      .filter((message) => message.role === 'ASSISTANT' && message.turnState === 'SUCCEEDED')
      .map((message) => ({
        messageId: message.messageId,
        messageSeq: message.messageSeq,
        turnNo: message.turnNo,
        contentVersion: message.contentVersion,
        analysisStatus: message.turnState,
        text: message.text,
        createdAt: message.createdAt,
      }));

    return {
      conversationId: snapshot.conversationId,
      requestId: snapshot.requestId,
      requestNo: snapshot.requestNo,
      contentVersion: snapshot.contentVersion,
      lastMessageSeq: snapshot.lastMessageSeq,
      replies,
    };
  }
}
