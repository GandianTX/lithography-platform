// src/usecases/ai-conversation/dispatch-ai-question.usecase.ts

import { Inject, Injectable, Logger } from '@nestjs/common';

import type { UsecaseSession } from '@app-types/auth/session.types';
import { AiConversationDispatchStatus } from '@app-types/models/ai-conversation.types';
import { buildAiConversationRequest } from '@src/core/ai/ai-conversation-request.policy';
import { AiConversationService } from '@src/modules/lithography/ai-conversation.service';
import { AiConversationQueryService } from '@src/modules/lithography/queries/ai-conversation.query.service';
import {
  AI_WORKFLOW_ADMISSION_PORT,
  type AiWorkflowAdmissionPort,
} from '@src/usecases/common/ports/ai-workflow-admission.contract';

import {
  AI_CONVERSATION_DISPATCH_OPTIONS,
  type AiConversationDispatchOptions,
} from '@src/infrastructure/ai/conversation/ai-conversation-dispatch.options';
import {
  AI_CONVERSATION_REPLY_WORKFLOW_TYPE,
  type AiConversationDispatchResult,
} from './ai-conversation-dispatch.types';

export interface DispatchAcceptedQuestionInput {
  readonly session: UsecaseSession;
  readonly conversationId: number;
  readonly questionUuid: string;
  readonly questionText: string;
  readonly turnNo: number;
  readonly messageSeq: number;
  readonly contentVersion: number;
  readonly stage: number | null;
}

/**
 * 受理后的派发用例（S2.1）：提交与重试共用。
 *
 * - 用「受理那一刻的事实」组装请求信封快照（历史、机型、阶段、问题 UUID），
 *   写入工作流上下文 `inputPayload`；重试不会重新读取后来的消息；
 * - 复用 `CreateAndAdmitAiWorkflowUsecase`：队列不可用时落到 `ADMISSION_WAITING`，
 *   由 housekeeping 重投，而不是把用户请求判失败；
 * - 派发异常时把本轮标记为可重试失败（`dispatch_failed`），避免界面长期停在「生成中」；
 * - 本用例不抛业务异常（返回 FAILED），避免已提交的问题因派发问题而「看不到」。
 */
@Injectable()
export class DispatchAiQuestionUsecase {
  private readonly logger = new Logger(DispatchAiQuestionUsecase.name);

  constructor(
    private readonly aiConversationService: AiConversationService,
    private readonly aiConversationQueryService: AiConversationQueryService,
    @Inject(AI_WORKFLOW_ADMISSION_PORT)
    private readonly workflowAdmission: AiWorkflowAdmissionPort,
    @Inject(AI_CONVERSATION_DISPATCH_OPTIONS)
    private readonly dispatchOptions: AiConversationDispatchOptions,
  ) {}

  async execute(input: DispatchAcceptedQuestionInput): Promise<AiConversationDispatchResult> {
    const conversation = await this.aiConversationService.findConversationById(
      input.conversationId,
    );
    if (!conversation) {
      await this.markDispatchFailed(input.questionUuid);
      return { status: AiConversationDispatchStatus.FAILED, workflowId: null, jobId: null };
    }

    const model = this.dispatchOptions.model;
    const provider = this.dispatchOptions.provider;

    const [history, equipmentModelCode] = await Promise.all([
      this.aiConversationService.listHistoryBeforeSeq({
        conversationId: input.conversationId,
        messageSeq: input.messageSeq,
      }),
      this.aiConversationQueryService.findEquipmentModelCodeByRequestId(conversation.requestId),
    ]);

    try {
      const requestPayload = buildAiConversationRequest({
        questionUuid: input.questionUuid,
        question: input.questionText,
        history,
        mode: conversation.requestId === null ? 'INDEPENDENT' : 'WORK_ORDER',
        equipmentModelCode,
        stage: input.stage,
      });

      const result = await this.workflowAdmission.execute({
        workflowType: AI_CONVERSATION_REPLY_WORKFLOW_TYPE,
        // 同一问题（含重试）共用去重键：前一次执行终态后哈希释放可重新受理；
        // 仍在执行中时返回 EXISTING_ACTIVE，不重复调用模型。
        workflowDedupKey: `ai_conversation_reply:${input.conversationId}:${input.questionUuid}`,
        inputPayload: {
          conversationId: input.conversationId,
          questionUuid: input.questionUuid,
          turnNo: input.turnNo,
          contentVersion: input.contentVersion,
          request: requestPayload,
          provider,
          model,
        },
        bizType: 'ai_conversation',
        bizKey: `conversation:${input.conversationId}`,
        bizSubKey: input.questionUuid,
        source: 'user_action',
        actorAccountId: input.session.accountId,
        actorActiveRole: input.session.activeRole ?? null,
        provider,
        model,
      });

      const status: AiConversationDispatchStatus =
        result.status === 'QUEUED' || result.status === 'STALE_QUEUED'
          ? AiConversationDispatchStatus.QUEUED
          : result.status === 'EXISTING_ACTIVE' || result.status === 'ADMISSION_WAITING'
            ? AiConversationDispatchStatus.DEFERRED
            : AiConversationDispatchStatus.FAILED;

      if (status === AiConversationDispatchStatus.FAILED) {
        await this.markDispatchFailed(input.questionUuid);
      }

      return {
        status,
        workflowId: result.workflowId,
        jobId: result.jobId,
      };
    } catch (error) {
      this.logger.error(
        {
          conversationId: input.conversationId,
          questionUuid: input.questionUuid,
          error: error instanceof Error ? error.message.slice(0, 200) : 'dispatch_error',
        },
        'AI 对话派发异常',
      );
      await this.markDispatchFailed(input.questionUuid);
      return { status: AiConversationDispatchStatus.FAILED, workflowId: null, jobId: null };
    }
  }

  private async markDispatchFailed(questionUuid: string): Promise<void> {
    try {
      await this.aiConversationService.markAnalysisFailed({
        questionUuid,
        reason: 'dispatch_failed',
      });
    } catch (error) {
      this.logger.warn(
        {
          questionUuid,
          error: error instanceof Error ? error.message.slice(0, 200) : 'mark_failed_error',
        },
        'AI 对话派发失败标记写入失败',
      );
    }
  }
}
