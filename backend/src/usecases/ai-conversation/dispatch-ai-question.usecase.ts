// src/usecases/ai-conversation/dispatch-ai-question.usecase.ts

import { Inject, Injectable, Logger } from '@nestjs/common';

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { AiConversationDispatchStatus } from '@app-types/models/ai-conversation.types';
import { buildAiConversationRequest } from '@src/core/ai/ai-conversation-request.policy';
import { AI_CONVERSATION_ERROR, DomainError } from '@src/core/common/errors/domain-error';
import { AiConversationService } from '@src/modules/lithography/ai-conversation.service';
import { AiConversationQueryService } from '@src/modules/lithography/queries/ai-conversation.query.service';

import {
  AI_WORKFLOW_ADMISSION_PORT,
  type AiWorkflowAdmissionPort,
  type AiWorkflowAdmissionPrepareResult,
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
 * 受理后的工作流派发用例（S2／Q01／B2）。
 *
 * 拆成两步，避免「先提交 PENDING、再创建执行」之间出现无执行事实的窗口：
 *
 * 1. `prepareWithinTransaction`：与问题／分析记录同一个数据库事务内，
 *    用受理那一刻的事实组装请求信封并落下 `ADMISSION_WAITING` 待准入事实；
 * 2. `admitPrepared`：事务提交后只做投递；投递失败时数据库事实仍在，
 *    由正式 housekeeping 恢复，不再把本轮判成失败。
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

  /**
   * 受理事务内准备执行事实。
   *
   * 必须由调用方在自己的事务内调用：任一步失败都要让问题／分析整体回滚（B2）。
   */
  async prepareWithinTransaction(
    input: DispatchAcceptedQuestionInput,
    transactionContext: PersistenceTransactionContext,
  ): Promise<AiWorkflowAdmissionPrepareResult> {
    const conversation = await this.aiConversationService.findConversationById(
      input.conversationId,
      transactionContext,
    );
    if (!conversation) {
      throw new DomainError(AI_CONVERSATION_ERROR.NOT_FOUND, 'AI 会话不存在，无法受理本轮', {
        conversationId: input.conversationId,
      });
    }

    const model = this.dispatchOptions.model;
    const provider = this.dispatchOptions.provider;

    const [history, equipmentModelCode] = await Promise.all([
      this.aiConversationService.listHistoryBeforeSeq(
        { conversationId: input.conversationId, messageSeq: input.messageSeq },
        transactionContext,
      ),
      this.aiConversationQueryService.findEquipmentModelCodeByRequestId(conversation.requestId),
    ]);

    const requestPayload = buildAiConversationRequest({
      questionUuid: input.questionUuid,
      question: input.questionText,
      history,
      mode: conversation.requestId === null ? 'INDEPENDENT' : 'WORK_ORDER',
      equipmentModelCode,
      stage: input.stage,
    });

    return await this.workflowAdmission.prepareInTransaction(
      {
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
      },
      transactionContext,
    );
  }

  /**
   * 事务提交后投递已准备的执行。
   *
   * 投递失败不再写失败态：数据库中的 `ADMISSION_WAITING`／`QUEUED` 事实由
   * housekeeping 重投，界面按「延迟」处理而不是让用户重试（Q01／B2）。
   */
  async admitPrepared(input: {
    readonly workflowId: string;
  }): Promise<AiConversationDispatchResult> {
    try {
      const result = await this.workflowAdmission.admitExisting({ workflowId: input.workflowId });
      const status: AiConversationDispatchStatus =
        result.status === 'QUEUED' || result.status === 'STALE_QUEUED'
          ? AiConversationDispatchStatus.QUEUED
          : // ADMISSION_WAITING / EXISTING_ACTIVE / CONFLICT：执行事实已在库内，等待重投
            AiConversationDispatchStatus.DEFERRED;
      return { status, workflowId: result.workflowId, jobId: result.jobId };
    } catch (error) {
      this.logger.warn(
        {
          workflowId: input.workflowId,
          error: error instanceof Error ? error.message.slice(0, 200) : 'admission_error',
        },
        'AI 对话投递异常，已保留待准入事实等待正式调度恢复',
      );
      return {
        status: AiConversationDispatchStatus.DEFERRED,
        workflowId: input.workflowId,
        jobId: null,
      };
    }
  }
}
