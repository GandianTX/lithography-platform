// src/usecases/ai-worker/ai-conversation-reply-workflow.handler.ts

import { Inject, Injectable } from '@nestjs/common';

import { AiConversationReplyError } from '@src/core/ai/ai-conversation-reply.policy';
import { isDomainError } from '@src/core/common/errors/domain-error';
import { normalizeOptionalText } from '@src/core/common/normalize/normalize.helper';
import { AiConversationRequestEnvelope } from '@src/core/ai/ai-conversation-request.policy';
import {
  AI_CONVERSATION_REPLY_WORKFLOW_TYPE,
  AiMessageAnalysisStatus,
} from '@app-types/models/ai-conversation.types';
import {
  AI_CONVERSATION_VISUALIZATION_STORE,
  type AiConversationVisualizationStore,
} from '@src/infrastructure/ai/conversation/ai-conversation-visualization.store';
import { AiConversationService } from '@src/modules/lithography/ai-conversation.service';
import {
  AI_CONVERSATION_MODEL_INVOKER,
  AiConversationModelFailureError,
  type AiConversationModelInvoker,
} from '@src/modules/common/ai-worker/conversation/ai-conversation-model.types';
import type {
  AiWorkflowContextView,
  AiWorkflowJsonPayload,
} from '@src/modules/ai-workflow-context/ai-workflow-context.types';
import {
  AI_CONVERSATION_EXECUTION_LOOKUP,
  type AiConversationExecutionLookupPort,
} from '@src/usecases/common/ports/ai-conversation-execution.contract';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';

import { AiWorkflowHandlerProvider } from './ai-workflow-handler.registry';
import type {
  AiWorkflowHandler,
  AiWorkflowHandlerProcessInput,
  AiWorkflowHandlerProcessResult,
} from './ai-workflow-handler.types';
import { AiWorkflowNonRetryableError } from './ai-workflow-worker-errors';

const REPLY_TEXT_MAX_UNITS = 12000;

/** 与派发侧一致的业务对象类型（当前执行查询使用） */
const EXECUTION_BIZ_TYPE = 'ai_conversation';

/** 写回事务内发现已被更新执行接管时使用（事务回滚，不写答案） */
class ExecutionSupersededError extends Error {
  constructor() {
    super('本轮已由更新的执行接管');
  }
}

interface AiConversationReplyPayload {
  readonly conversationId: number;
  readonly questionUuid: string;
  readonly turnNo: number;
  readonly contentVersion: number;
  readonly request: AiConversationRequestEnvelope;
  readonly provider: string | null;
  readonly model: string;
}

/**
 * AI 对话回复工作流 handler（S2.1／S2.2）
 *
 * 不变量：
 * 1. **重复回放不重复调用模型**：分析已成功且有回答时直接返回既有事实；
 * 2. **正文与有效回答同次保存**：回答消息插入与分析完成在同一事务内；
 * 3. **迟到结果不覆盖新回答**：分析完成使用条件更新（仅 PENDING 且无回答），
 *    竞争失败时整体回滚并丢弃本次模型结果；
 * 4. **图形只走短时通道**：Redis 保存失败只降级，不影响正文与状态；
 * 5. **失败可诊断**：解析或模型失败写入 `failure_reason` 后按不可重试失败结束工作流，
 *    由用户显式重试（重试沿用同一问题 UUID）。
 */
@Injectable()
@AiWorkflowHandlerProvider()
export class AiConversationReplyWorkflowHandler implements AiWorkflowHandler {
  readonly workflowType = AI_CONVERSATION_REPLY_WORKFLOW_TYPE;

  constructor(
    private readonly aiConversationService: AiConversationService,
    @Inject(AI_CONVERSATION_MODEL_INVOKER)
    private readonly modelInvoker: AiConversationModelInvoker,
    @Inject(AI_CONVERSATION_VISUALIZATION_STORE)
    private readonly visualizationStore: AiConversationVisualizationStore,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    @Inject(AI_CONVERSATION_EXECUTION_LOOKUP)
    private readonly executionLookup: AiConversationExecutionLookupPort,
  ) {}

  async handle(input: AiWorkflowHandlerProcessInput): Promise<AiWorkflowHandlerProcessResult> {
    const payload = normalizePayload(input.inputPayload);

    const analysis = await this.aiConversationService.findAnalysisByQuestion(payload.questionUuid);
    if (!analysis || analysis.conversationId !== payload.conversationId) {
      throw new AiWorkflowNonRetryableError('本轮分析记录不存在或不属于该会话', 'analysis_missing');
    }
    if (
      analysis.status === AiMessageAnalysisStatus.SUCCEEDED &&
      analysis.answerMessageId !== null
    ) {
      // 重复回放：不再调用模型，直接以已保存事实结束
      return this.buildReusedResult(input.context, payload, analysis.answerMessageId);
    }
    if (analysis.status === AiMessageAnalysisStatus.FAILED) {
      throw new AiWorkflowNonRetryableError(
        '本轮已标记失败，需用户重试',
        'analysis_terminal_failed',
      );
    }

    // F04：模型调用前确认本执行仍是当前执行；旧执行不得再调用模型
    await this.assertCurrentExecution({
      questionUuid: payload.questionUuid,
      workflowId: input.context.workflowId,
      message: '本轮已由更新的执行接管，本次不再调用模型',
    });

    const providerStartedAtFallback = new Date();
    let invocation;
    try {
      invocation = await this.modelInvoker.invoke({
        request: payload.request,
        provider: payload.provider,
        model: payload.model,
        metadata: {
          workflowId: input.context.workflowId,
          workflowType: input.context.workflowType,
          traceId: input.context.traceId,
        },
      });
    } catch (error) {
      const reason = this.resolveFailureReason(error);
      // F04：旧执行的失败不得覆盖新执行的 PENDING 状态
      if (
        await this.isCurrentExecution({
          questionUuid: payload.questionUuid,
          workflowId: input.context.workflowId,
        })
      ) {
        await this.aiConversationService.markAnalysisFailed({
          questionUuid: payload.questionUuid,
          reason,
        });
        throw new AiWorkflowNonRetryableError('模型调用或回复解析失败', reason);
      }
      throw new AiWorkflowNonRetryableError(
        '本轮已由更新的执行接管，本次失败不写回',
        'execution_superseded',
      );
    }

    let saved: { readonly answerMessageId: number; readonly messageSeq: number } | null;
    try {
      saved = await this.transactionRunner.run(async (transactionContext) => {
        // F04：写回前在同一事务内再次核对当前执行，旧执行不得占用新的 PENDING
        if (
          !(await this.isCurrentExecution({
            questionUuid: payload.questionUuid,
            workflowId: input.context.workflowId,
            transactionContext,
          }))
        ) {
          throw new ExecutionSupersededError();
        }
        const facts = await this.aiConversationService.getSequenceFacts(
          payload.conversationId,
          transactionContext,
        );
        const answer = await this.aiConversationService.insertAnswerMessage(
          {
            conversationId: payload.conversationId,
            messageSeq: facts.maxMessageSeq + 1,
            turnNo: payload.turnNo,
            contentText: invocation.text.slice(0, REPLY_TEXT_MAX_UNITS),
            contentVersion: payload.contentVersion,
          },
          transactionContext,
        );
        const won = await this.aiConversationService.completeAnalysis(
          {
            questionUuid: payload.questionUuid,
            answerMessageId: answer.id,
            contentVersion: payload.contentVersion,
            completedAt: new Date(),
          },
          transactionContext,
        );
        if (!won) {
          throw new AnalysisRaceLostError();
        }
        return { answerMessageId: answer.id, messageSeq: answer.messageSeq };
      });
    } catch (error) {
      if (error instanceof ExecutionSupersededError) {
        throw new AiWorkflowNonRetryableError(
          '本轮已由更新的执行接管，本次结果丢弃',
          'execution_superseded',
        );
      }
      if (!(error instanceof AnalysisRaceLostError)) {
        throw error;
      }
      // 竞争失败：本次事务已回滚（回答消息未落库），以先到者事实为准
      const latest = await this.aiConversationService.findAnalysisByQuestion(payload.questionUuid);
      if (!latest || latest.answerMessageId === null) {
        throw new AiWorkflowNonRetryableError(
          '本轮分析状态已被其他执行改变',
          'analysis_state_conflict',
        );
      }
      return this.buildReusedResult(input.context, payload, latest.answerMessageId);
    }

    const visualizationSaved =
      invocation.visualization === null
        ? false
        : await this.visualizationStore.save(
            {
              conversationId: payload.conversationId,
              questionUuid: payload.questionUuid,
              contentVersion: payload.contentVersion,
            },
            invocation.visualization,
          );

    return {
      outputPayload: {
        conversationId: payload.conversationId,
        questionUuid: payload.questionUuid,
        answerMessageId: saved.answerMessageId,
        messageSeq: saved.messageSeq,
        contentVersion: payload.contentVersion,
        textLength: invocation.text.length,
        visualizationSaved,
        visualizationDegraded: invocation.visualizationDegraded,
        devFixture: invocation.devFixture,
        provider: invocation.provider,
        model: invocation.model,
        providerJobId: invocation.providerJobId,
        providerRequestId: invocation.providerRequestId,
      },
      ...(invocation.generateResult
        ? {
            providerCall: {
              taskType: 'generate' as const,
              result: invocation.generateResult,
              providerStartedAtFallback,
            },
          }
        : {}),
    };
  }

  /** 当前执行断言：不成立即按不可重试失败终止（F04） */
  private async assertCurrentExecution(input: {
    readonly questionUuid: string;
    readonly workflowId: string;
    readonly message: string;
    readonly transactionContext?: import('@app-types/common/transaction.types').PersistenceTransactionContext;
  }): Promise<void> {
    if (await this.isCurrentExecution(input)) {
      return;
    }
    throw new AiWorkflowNonRetryableError(input.message, 'execution_superseded');
  }

  /**
   * 当前有效执行判定（F04）：该问题最近创建的工作流执行 ID 是否等于本执行。
   *
   * 无法证明（无记录或读取失败）时按「不是当前执行」处理，避免旧执行写入。
   */
  private async isCurrentExecution(input: {
    readonly questionUuid: string;
    readonly workflowId: string;
    readonly transactionContext?: import('@app-types/common/transaction.types').PersistenceTransactionContext;
  }): Promise<boolean> {
    try {
      const latest = await this.executionLookup.findLatestWorkflowIdByBizTarget({
        bizType: EXECUTION_BIZ_TYPE,
        bizSubKey: input.questionUuid,
        transactionContext: input.transactionContext,
      });
      return latest !== null && latest === input.workflowId;
    } catch {
      return false;
    }
  }

  private buildReusedResult(
    context: AiWorkflowContextView,
    payload: AiConversationReplyPayload,
    answerMessageId: number,
  ): AiWorkflowHandlerProcessResult {
    return {
      outputPayload: {
        conversationId: payload.conversationId,
        questionUuid: payload.questionUuid,
        answerMessageId,
        contentVersion: payload.contentVersion,
        reused: true,
        workflowType: context.workflowType,
      },
    };
  }

  private resolveFailureReason(error: unknown): string {
    if (error instanceof AiConversationReplyError) {
      return `reply_${error.reason}`;
    }
    // 公共 RAG 客户端的可辨识失败码（如 TIMEOUT、SERVICE_UNAVAILABLE）
    if (error instanceof AiConversationModelFailureError) {
      return `reply_${error.failureCode.toLowerCase()}`;
    }
    if (isDomainError(error) && error.code.toLowerCase().includes('timeout')) {
      return 'reply_timeout';
    }
    if (error instanceof Error && error.message.toLowerCase().includes('timeout')) {
      return 'reply_timeout';
    }
    return 'reply_unavailable';
  }
}

/** 内部信号：条件更新未命中，说明本次结果已过期 */
class AnalysisRaceLostError extends Error {
  constructor() {
    super('analysis_race_lost');
    this.name = 'AnalysisRaceLostError';
  }
}

function normalizePayload(payload: AiWorkflowJsonPayload): AiConversationReplyPayload {
  if (!isJsonObjectPayload(payload)) {
    throw new AiWorkflowNonRetryableError(
      '对话工作流入参不是对象',
      'workflow_input_payload_invalid',
    );
  }
  const record = payload;
  if (!hasRequiredPayloadFields(record)) {
    throw new AiWorkflowNonRetryableError(
      '对话工作流入参缺少必要字段',
      'workflow_input_payload_invalid',
    );
  }
  return {
    conversationId: record.conversationId,
    questionUuid: record.questionUuid,
    turnNo: record.turnNo,
    contentVersion: record.contentVersion,
    request: record.request,
    provider: normalizeOptionalPayloadText(record.provider),
    model: normalizeOptionalPayloadText(record.model) ?? 'qwen-plus',
  };
}

type AiWorkflowJsonObjectPayload = Extract<
  AiWorkflowJsonPayload,
  { readonly [key: string]: unknown }
>;

interface AiConversationReplyPayloadFields {
  readonly conversationId: number;
  readonly questionUuid: string;
  readonly turnNo: number;
  readonly contentVersion: number;
  readonly request: AiConversationRequestEnvelope;
}

function isJsonObjectPayload(
  payload: AiWorkflowJsonPayload,
): payload is AiWorkflowJsonObjectPayload {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload);
}

function hasRequiredPayloadFields(
  record: AiWorkflowJsonObjectPayload,
): record is AiWorkflowJsonObjectPayload & AiConversationReplyPayloadFields {
  return (
    isPositiveIntegerField(record.conversationId) &&
    typeof record.questionUuid === 'string' &&
    record.questionUuid.length > 0 &&
    isPositiveIntegerField(record.turnNo) &&
    isPositiveIntegerField(record.contentVersion) &&
    isRequestEnvelope(record.request)
  );
}

function isPositiveIntegerField(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function normalizeOptionalPayloadText(value: unknown): string | null {
  return normalizeOptionalText(value);
}

function isRequestEnvelope(value: unknown): value is AiConversationRequestEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const envelope = value as Record<string, unknown>;
  return (
    envelope.schemaVersion === 1 &&
    typeof envelope.requestId === 'string' &&
    typeof envelope.question === 'string' &&
    Array.isArray(envelope.history) &&
    typeof envelope.context === 'object' &&
    envelope.context !== null
  );
}
