// src/usecases/ai-worker/ai-conversation-reply-workflow.handler.spec.ts
/// <reference types="jest" />

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { AiMessageAnalysisStatus } from '@app-types/models/ai-conversation.types';
import { AiConversationReplyError } from '@src/core/ai/ai-conversation-reply.policy';
import type { AiConversationRequestEnvelope } from '@src/core/ai/ai-conversation-request.policy';
import { DomainError } from '@src/core/common/errors/domain-error';
import type { AiConversationService } from '@src/modules/lithography/ai-conversation.service';
import type { AiWorkflowContextView } from '@src/modules/ai-workflow-context/ai-workflow-context.types';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';

import { AiConversationModelFailureError } from '@src/modules/common/ai-worker/conversation/ai-conversation-model.types';

import { AiConversationReplyWorkflowHandler } from './ai-conversation-reply-workflow.handler';

const QUESTION_UUID = '3f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';

const REQUEST: AiConversationRequestEnvelope = {
  schemaVersion: 1,
  requestId: QUESTION_UUID,
  sceneId: 'LITHO_WORKFLOW_V1',
  question: '对准偏差如何排查？',
  history: [],
  context: { mode: 'INDEPENDENT', equipmentModelCode: null, stage: 2, fault: null },
};

const CONTEXT: AiWorkflowContextView = {
  workflowId: 'wf-1',
  workflowType: 'ai_conversation_reply',
  traceId: 'trace-1',
  status: 'PROCESSING',
  provider: null,
  model: 'qwen-plus',
  jobId: 'job-1',
  queueName: 'ai-workflow',
  jobName: 'workflow',
  actorAccountId: 10,
  actorActiveRole: 'ENGINEER',
  source: 'user_action',
  bizType: 'ai_conversation',
  bizKey: 'conversation:7',
  bizSubKey: QUESTION_UUID,
  attemptCount: 1,
  maxAttempts: 3,
  nextEnqueueAt: null,
  admissionExpiresAt: null,
  admissionReason: null,
  processingExpiresAt: null,
  errorCode: null,
  errorMessage: null,
  createdAt: new Date('2026-11-18T10:00:00.000Z'),
  updatedAt: new Date('2026-11-18T10:00:00.000Z'),
} as unknown as AiWorkflowContextView;

const INVOCATION_OK = {
  text: '建议先核对取板台状态。',
  visualization: {
    sceneId: 'LITHO_WORKFLOW_V1',
    stage: 2,
    parts: [{ partId: 'reticle_arm', display: 'HIGHLIGHT' }],
  },
  visualizationDegraded: false,
  provider: 'mock',
  model: 'qwen-plus',
  providerJobId: 'p-1',
  providerRequestId: null,
  generateResult: null,
  devFixture: true,
};

describe('AiConversationReplyWorkflowHandler', () => {
  const transactionContext = Symbol('tx') as unknown as PersistenceTransactionContext;

  let aiConversationService: Record<string, jest.Mock>;
  let modelInvoker: { invoke: jest.Mock };
  let visualizationStore: { save: jest.Mock; load: jest.Mock };
  let transactionRunner: TransactionRunner;
  let executionLookup: {
    findActiveExecutionByBizTarget: jest.Mock;
    findLatestExecutionByBizTarget: jest.Mock;
    listTerminalExecutionsSince: jest.Mock;
  };
  let handler: AiConversationReplyWorkflowHandler;

  beforeEach(() => {
    aiConversationService = {
      findAnalysisByQuestion: jest.fn(),
      lockConversationForWrite: jest.fn().mockResolvedValue({ id: 7, status: 'ACTIVE' }),
      getSequenceFacts: jest.fn().mockResolvedValue({ maxMessageSeq: 5, maxTurnNo: 1 }),
      bumpContentVersion: jest.fn().mockResolvedValue(3),
      insertAnswerMessage: jest.fn(),
      completeAnalysis: jest.fn().mockResolvedValue(true),
      markAnalysisFailed: jest.fn().mockResolvedValue(true),
    };
    modelInvoker = { invoke: jest.fn().mockResolvedValue({ ...INVOCATION_OK }) };
    visualizationStore = { save: jest.fn().mockResolvedValue(true), load: jest.fn() };
    transactionRunner = {
      run: jest.fn(async (work: (context: PersistenceTransactionContext) => Promise<unknown>) =>
        work(transactionContext),
      ),
    } as unknown as TransactionRunner;

    // 默认：本执行即当前执行；F04 反例再覆盖为更新的执行
    executionLookup = {
      findActiveExecutionByBizTarget: jest.fn().mockResolvedValue({
        workflowId: CONTEXT.workflowId,
        status: 'PROCESSING',
        jobId: 'job-1',
        nextEnqueueAt: null,
        admissionExpiresAt: null,
      }),
      // handler 只用活动执行判定；最近执行读取与终态扫描由 Worker 侧收敛使用
      findLatestExecutionByBizTarget: jest.fn().mockResolvedValue(null),
      listTerminalExecutionsSince: jest.fn().mockResolvedValue([]),
    };

    handler = new AiConversationReplyWorkflowHandler(
      aiConversationService as unknown as AiConversationService,
      modelInvoker,
      visualizationStore,
      transactionRunner,
      executionLookup,
    );
  });

  const payload = (overrides: Record<string, unknown> = {}) => ({
    conversationId: 7,
    questionUuid: QUESTION_UUID,
    turnNo: 1,
    contentVersion: 2,
    request: REQUEST,
    provider: null,
    model: 'qwen-plus',
    ...overrides,
  });

  const analysis = (overrides: Record<string, unknown> = {}) => ({
    questionUuid: QUESTION_UUID,
    conversationId: 7,
    questionMessageId: 1,
    answerMessageId: null,
    status: AiMessageAnalysisStatus.PENDING,
    failureReason: null,
    contentVersion: 2,
    savedAt: new Date(),
    completedAt: null,
    ...overrides,
  });

  const run = () =>
    handler.handle({
      context: CONTEXT,
      inputPayload: payload(),
    });

  it('成功路径：回答消息与分析完成同事务保存，并写入图形通道', async () => {
    aiConversationService.findAnalysisByQuestion.mockResolvedValue(analysis());
    aiConversationService.insertAnswerMessage.mockResolvedValue({
      id: 42,
      conversationId: 7,
      questionUuid: null,
      messageSeq: 6,
      turnNo: 1,
      contentText: INVOCATION_OK.text,
      contentVersion: 3,
      createdAt: new Date(),
    });

    const result = await run();

    expect(result.outputPayload).toMatchObject({
      conversationId: 7,
      questionUuid: QUESTION_UUID,
      answerMessageId: 42,
      // F05：回答是追加内容，版本推进到 3，而受理版本是 2
      contentVersion: 3,
      visualizationSaved: true,
    });
    expect(aiConversationService.bumpContentVersion).toHaveBeenCalledWith(7, transactionContext);
    expect(aiConversationService.insertAnswerMessage).toHaveBeenCalledWith(
      expect.objectContaining({ contentVersion: 3, turnNo: 1 }),
      transactionContext,
    );
    expect(aiConversationService.completeAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ questionUuid: QUESTION_UUID, answerMessageId: 42 }),
      transactionContext,
    );
    expect(visualizationStore.save).toHaveBeenCalledWith(
      { conversationId: 7, questionUuid: QUESTION_UUID, contentVersion: 3 },
      {
        sceneId: 'LITHO_WORKFLOW_V1',
        stage: 2,
        parts: [{ partId: 'reticle_arm', display: 'HIGHLIGHT' }],
      },
    );
  });

  it('重复回放：分析已成功时不调用模型，直接以既有事实结束', async () => {
    aiConversationService.findAnalysisByQuestion.mockResolvedValue(
      analysis({
        status: AiMessageAnalysisStatus.SUCCEEDED,
        answerMessageId: 42,
      }),
    );

    const result = await run();

    expect(modelInvoker.invoke).not.toHaveBeenCalled();
    expect(result.outputPayload).toMatchObject({ reused: true, answerMessageId: 42 });
  });

  it('迟到结果：条件更新未命中时整体回滚，不得覆盖新回答', async () => {
    aiConversationService.findAnalysisByQuestion.mockResolvedValue(analysis());
    aiConversationService.insertAnswerMessage.mockResolvedValue({
      id: 43,
      conversationId: 7,
      questionUuid: null,
      messageSeq: 6,
      turnNo: 1,
      contentText: INVOCATION_OK.text,
      contentVersion: 3,
      createdAt: new Date(),
    });
    aiConversationService.completeAnalysis.mockResolvedValue(false);
    // 回滚后回读：先到者已保存回答
    aiConversationService.findAnalysisByQuestion
      .mockResolvedValueOnce(analysis())
      .mockResolvedValue({
        ...analysis(),
        status: AiMessageAnalysisStatus.SUCCEEDED,
        answerMessageId: 40,
      });

    const result = await run();

    expect(result.outputPayload).toMatchObject({ reused: true, answerMessageId: 40 });
    // 不应把迟到结果标记为失败
    expect(aiConversationService.markAnalysisFailed).not.toHaveBeenCalled();
  });

  it('回复解析失败：标记失败原因并按不可重试错误结束', async () => {
    aiConversationService.findAnalysisByQuestion.mockResolvedValue(analysis());
    modelInvoker.invoke.mockRejectedValue(
      new AiConversationReplyError('request_id_mismatch', '标识不一致'),
    );

    await expect(run()).rejects.toMatchObject({ reason: 'reply_request_id_mismatch' });
    expect(aiConversationService.markAnalysisFailed).toHaveBeenCalledWith(
      {
        questionUuid: QUESTION_UUID,
        reason: 'reply_request_id_mismatch',
      },
      expect.anything(),
    );
  });

  it('模型调用失败（超时）：标记 reply_timeout 并终止工作流', async () => {
    aiConversationService.findAnalysisByQuestion.mockResolvedValue(analysis());
    modelInvoker.invoke.mockRejectedValue(new DomainError('ai_provider_timeout', '模型超时'));

    await expect(run()).rejects.toMatchObject({ reason: 'reply_timeout' });
    expect(aiConversationService.markAnalysisFailed).toHaveBeenCalledWith(
      {
        questionUuid: QUESTION_UUID,
        reason: 'reply_timeout',
      },
      expect.anything(),
    );
  });

  it('公共 RAG 客户端失败：按可辨识短码写入 failure_reason', async () => {
    aiConversationService.findAnalysisByQuestion.mockResolvedValue(analysis());
    modelInvoker.invoke.mockRejectedValue(
      new AiConversationModelFailureError('SERVICE_UNAVAILABLE', 'RAG 诊断调用失败'),
    );

    await expect(run()).rejects.toMatchObject({ reason: 'reply_service_unavailable' });
    expect(aiConversationService.markAnalysisFailed).toHaveBeenCalledWith(
      {
        questionUuid: QUESTION_UUID,
        reason: 'reply_service_unavailable',
      },
      expect.anything(),
    );
  });

  it('分析记录缺失：不可重试失败且不调用模型', async () => {
    aiConversationService.findAnalysisByQuestion.mockResolvedValue(null);

    await expect(run()).rejects.toMatchObject({ reason: 'analysis_missing' });
    expect(modelInvoker.invoke).not.toHaveBeenCalled();
  });
  it('F04：旧执行迟到（当前执行已是新 workflow）时不调用模型也不写答案', async () => {
    aiConversationService.findAnalysisByQuestion.mockResolvedValue(analysis());
    executionLookup.findActiveExecutionByBizTarget.mockResolvedValue({
      workflowId: 'wf-2',
      status: 'PROCESSING',
      jobId: 'job-2',
    });

    await expect(run()).rejects.toMatchObject({ reason: 'execution_superseded' });
    expect(modelInvoker.invoke).not.toHaveBeenCalled();
    expect(aiConversationService.insertAnswerMessage).not.toHaveBeenCalled();
    expect(aiConversationService.completeAnalysis).not.toHaveBeenCalled();
    expect(aiConversationService.markAnalysisFailed).not.toHaveBeenCalled();
  });

  it('S2.2-1：同 biz 同 workflow 但活动 job 已更换时，旧 job 迟到不得写回', async () => {
    aiConversationService.findAnalysisByQuestion.mockResolvedValue(analysis());
    // 反例关键点：workflowId 与 biz 归属完全一致，只有 jobId 不同（该 workflow 被重新入队）。
    // 若实现只比对 workflowId，本用例会走到调用模型／写答案，断言即失败。
    executionLookup.findActiveExecutionByBizTarget.mockResolvedValue({
      workflowId: CONTEXT.workflowId,
      status: 'QUEUED',
      jobId: 'job-requeued-2',
    });

    await expect(run()).rejects.toMatchObject({ reason: 'execution_superseded' });
    expect(modelInvoker.invoke).not.toHaveBeenCalled();
    expect(aiConversationService.insertAnswerMessage).not.toHaveBeenCalled();
    expect(aiConversationService.completeAnalysis).not.toHaveBeenCalled();
  });

  it('S2.2-1：活动执行缺少 job 身份时按无法证明处理（失败关闭）', async () => {
    aiConversationService.findAnalysisByQuestion.mockResolvedValue(analysis());
    executionLookup.findActiveExecutionByBizTarget.mockResolvedValue({
      workflowId: CONTEXT.workflowId,
      status: 'PROCESSING',
      jobId: null,
    });

    await expect(run()).rejects.toMatchObject({ reason: 'execution_superseded' });
    expect(modelInvoker.invoke).not.toHaveBeenCalled();
  });

  it('F04：模型已返回但写回前被新执行接管时，事务回滚且不改状态', async () => {
    aiConversationService.findAnalysisByQuestion.mockResolvedValue(analysis());
    executionLookup.findActiveExecutionByBizTarget
      .mockResolvedValueOnce({
        workflowId: CONTEXT.workflowId,
        status: 'PROCESSING',
        jobId: 'job-1',
      })
      .mockResolvedValue({ workflowId: 'wf-2', status: 'QUEUED', jobId: 'job-2' });

    await expect(run()).rejects.toMatchObject({ reason: 'execution_superseded' });
    expect(modelInvoker.invoke).toHaveBeenCalledTimes(1);
    expect(aiConversationService.insertAnswerMessage).not.toHaveBeenCalled();
    expect(aiConversationService.completeAnalysis).not.toHaveBeenCalled();
    expect(aiConversationService.markAnalysisFailed).not.toHaveBeenCalled();
  });

  it('F04：模型失败但已被新执行接管时，不把新执行标记为失败', async () => {
    aiConversationService.findAnalysisByQuestion.mockResolvedValue(analysis());
    modelInvoker.invoke.mockRejectedValue(new DomainError('MODEL_ERROR', '模型超时'));
    executionLookup.findActiveExecutionByBizTarget
      .mockResolvedValueOnce({
        workflowId: CONTEXT.workflowId,
        status: 'PROCESSING',
        jobId: 'job-1',
      })
      .mockResolvedValue({ workflowId: 'wf-2', status: 'QUEUED', jobId: 'job-2' });

    await expect(run()).rejects.toMatchObject({ reason: 'execution_superseded' });
    expect(aiConversationService.markAnalysisFailed).not.toHaveBeenCalled();
  });

  it('F04：无法证明当前执行（查不到记录）时失败关闭', async () => {
    aiConversationService.findAnalysisByQuestion.mockResolvedValue(analysis());
    executionLookup.findActiveExecutionByBizTarget.mockResolvedValue(null);

    await expect(run()).rejects.toMatchObject({ reason: 'execution_superseded' });
    expect(modelInvoker.invoke).not.toHaveBeenCalled();
  });
});
