/// <reference types="jest" />
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  AiConversationStatus,
  AiMessageAnalysisStatus,
} from '@app-types/models/ai-conversation.types';
import { AI_CONVERSATION_ERROR, DomainError } from '@src/core/common/errors/domain-error';
import type { AiConversationService } from '@src/modules/lithography/ai-conversation.service';
import type { RepairRequestQueryService } from '@src/modules/lithography/queries/repair-request.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import type { DispatchAiQuestionUsecase } from './dispatch-ai-question.usecase';
import { SubmitAiQuestionUsecase } from './submit-ai-question.usecase';

type AiConversationServiceMock = {
  lockConversationForWrite: jest.Mock;
  findQuestionByUuid: jest.Mock;
  getSequenceFacts: jest.Mock;
  insertUserMessage: jest.Mock;
  bumpContentVersion: jest.Mock;
  insertAnalysis: jest.Mock;
  findAnalysisByQuestion: jest.Mock;
};

type OrganizationContextMock = {
  resolveForAccount: jest.Mock;
  tryResolveForAccount: jest.Mock;
};

const ENGINEER_SESSION: UsecaseSession = {
  accountId: 10,
  roles: [IdentityTypeEnum.ENGINEER],
  activeRole: IdentityTypeEnum.ENGINEER,
};

const QUESTION_UUID = '3f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';

describe('SubmitAiQuestionUsecase', () => {
  const transactionContext = Symbol(
    'transactionContext',
  ) as unknown as PersistenceTransactionContext;

  let aiConversationService: AiConversationServiceMock;
  let organizationContextService: OrganizationContextMock;
  let repairRequestQueryService: { findAssociationTarget: jest.Mock };
  let dispatchUsecase: { prepareWithinTransaction: jest.Mock; admitPrepared: jest.Mock };
  let transactionRunner: TransactionRunner;
  let usecase: SubmitAiQuestionUsecase;

  beforeEach(() => {
    aiConversationService = {
      lockConversationForWrite: jest.fn(),
      findQuestionByUuid: jest.fn(),
      getSequenceFacts: jest.fn(),
      insertUserMessage: jest.fn(),
      bumpContentVersion: jest.fn(),
      insertAnalysis: jest.fn(),
      findAnalysisByQuestion: jest.fn(),
    };
    organizationContextService = {
      resolveForAccount: jest.fn().mockResolvedValue({ organizationId: 2, memberRole: 'ENGINEER' }),
      tryResolveForAccount: jest.fn(),
    };
    repairRequestQueryService = {
      // 独立会话不读取工单事实；工单会话用例按需覆盖
      findAssociationTarget: jest.fn().mockResolvedValue(null),
    };
    dispatchUsecase = {
      prepareWithinTransaction: jest
        .fn()
        .mockResolvedValue({ status: 'PREPARED', workflowId: 'wf-1' }),
      admitPrepared: jest
        .fn()
        .mockResolvedValue({ status: 'QUEUED', workflowId: 'wf-1', jobId: 'job-1' }),
    };
    transactionRunner = {
      run: jest.fn(async (work: (context: PersistenceTransactionContext) => Promise<unknown>) =>
        work(transactionContext),
      ),
    } as unknown as TransactionRunner;

    usecase = new SubmitAiQuestionUsecase(
      aiConversationService as unknown as AiConversationService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      repairRequestQueryService as unknown as RepairRequestQueryService,
      dispatchUsecase as unknown as DispatchAiQuestionUsecase,
      transactionRunner,
    );
  });

  const buildCommand = (overrides: { question?: string; questionUuid?: string } = {}) => ({
    session: ENGINEER_SESSION,
    conversationId: 7,
    questionUuid: overrides.questionUuid ?? QUESTION_UUID,
    question: overrides.question ?? '对准偏差 3μm 如何排查？',
  });

  const lockSnapshot = (overrides: Record<string, unknown> = {}) => ({
    id: 7,
    requestId: null,
    ownerOrganizationId: 2,
    contentVersion: 3,
    engineerAccountId: 10,
    status: AiConversationStatus.ACTIVE,
    ...overrides,
  });

  it('首次提交：同事务写入问题、推进版本并创建 PENDING 分析', async () => {
    aiConversationService.lockConversationForWrite.mockResolvedValue(lockSnapshot());
    aiConversationService.findQuestionByUuid.mockResolvedValue(null);
    aiConversationService.getSequenceFacts.mockResolvedValue({ maxMessageSeq: 4, maxTurnNo: 2 });
    aiConversationService.insertUserMessage.mockResolvedValue({
      id: 21,
      conversationId: 7,
      questionUuid: QUESTION_UUID,
      messageSeq: 5,
      turnNo: 3,
      contentText: '对准偏差 3μm 如何排查？',
      contentVersion: 4,
      createdAt: new Date('2026-11-18T10:00:00.000Z'),
    });
    aiConversationService.bumpContentVersion.mockResolvedValue(4);
    aiConversationService.insertAnalysis.mockResolvedValue({
      questionUuid: QUESTION_UUID,
      conversationId: 7,
      questionMessageId: 21,
      answerMessageId: null,
      status: AiMessageAnalysisStatus.PENDING,
      failureReason: null,
      contentVersion: 4,
      savedAt: new Date('2026-11-18T10:00:00.000Z'),
      completedAt: null,
    });

    const result = await usecase.execute(buildCommand());

    expect(result).toMatchObject({
      conversationId: 7,
      questionUuid: QUESTION_UUID,
      status: AiMessageAnalysisStatus.PENDING,
      turnNo: 3,
      messageSeq: 5,
      contentVersion: 4,
      replayed: false,
    });
    expect(aiConversationService.insertUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageSeq: 5,
        turnNo: 3,
        questionUuid: QUESTION_UUID,
        // 同一轮的问题消息、分析与会话版本必须一致
        contentVersion: 4,
      }),
      transactionContext,
    );
    expect(aiConversationService.insertAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ questionUuid: QUESTION_UUID, contentVersion: 4 }),
      transactionContext,
    );
    // Q01／B2：执行事实与问题／分析同一事务，投递发生在提交之后
    expect(dispatchUsecase.prepareWithinTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 7,
        questionUuid: QUESTION_UUID,
        messageSeq: 5,
        contentVersion: 4,
      }),
      transactionContext,
    );
    expect(dispatchUsecase.admitPrepared).toHaveBeenCalledWith({ workflowId: 'wf-1' });
    expect(transactionRunner.run).toHaveBeenCalledTimes(1);
  });

  it('Q01／B2：执行事实准备失败时整笔受理失败，不留无执行的问题', async () => {
    aiConversationService.lockConversationForWrite.mockResolvedValue(lockSnapshot());
    aiConversationService.findQuestionByUuid.mockResolvedValue(null);
    aiConversationService.getSequenceFacts.mockResolvedValue({ maxMessageSeq: 4, maxTurnNo: 2 });
    aiConversationService.bumpContentVersion.mockResolvedValue(4);
    aiConversationService.insertUserMessage.mockResolvedValue({
      id: 21,
      conversationId: 7,
      questionUuid: QUESTION_UUID,
      messageSeq: 5,
      turnNo: 3,
      contentText: '对准偏差 3μm 如何排查？',
      contentVersion: 4,
      createdAt: new Date('2026-11-18T10:00:00.000Z'),
    });
    aiConversationService.insertAnalysis.mockResolvedValue({
      questionUuid: QUESTION_UUID,
      conversationId: 7,
      questionMessageId: 21,
      answerMessageId: null,
      status: AiMessageAnalysisStatus.PENDING,
      failureReason: null,
      contentVersion: 4,
      savedAt: new Date('2026-11-18T10:00:00.000Z'),
      completedAt: null,
    });
    dispatchUsecase.prepareWithinTransaction.mockRejectedValue(new Error('context_create_failed'));

    await expect(usecase.execute(buildCommand())).rejects.toThrow('context_create_failed');
    expect(dispatchUsecase.admitPrepared).not.toHaveBeenCalled();
  });

  it('同 UUID 同内容：幂等回放既有分析，不新增消息', async () => {
    aiConversationService.lockConversationForWrite.mockResolvedValue(lockSnapshot());
    aiConversationService.findQuestionByUuid.mockResolvedValue({
      id: 21,
      conversationId: 7,
      questionUuid: QUESTION_UUID,
      messageSeq: 5,
      turnNo: 3,
      contentText: '对准偏差 3μm 如何排查？',
      contentVersion: 1,
      createdAt: new Date('2026-11-18T10:00:00.000Z'),
    });
    aiConversationService.findAnalysisByQuestion.mockResolvedValue({
      questionUuid: QUESTION_UUID,
      conversationId: 7,
      questionMessageId: 21,
      answerMessageId: null,
      status: AiMessageAnalysisStatus.PENDING,
      failureReason: null,
      contentVersion: 4,
      savedAt: new Date('2026-11-18T10:00:00.000Z'),
      completedAt: null,
    });

    const result = await usecase.execute(buildCommand());

    expect(result.replayed).toBe(true);
    expect(result.messageSeq).toBe(5);
    expect(result.status).toBe(AiMessageAnalysisStatus.PENDING);
    expect(aiConversationService.insertUserMessage).not.toHaveBeenCalled();
    expect(aiConversationService.insertAnalysis).not.toHaveBeenCalled();
    expect(aiConversationService.bumpContentVersion).not.toHaveBeenCalled();
  });

  it('同 UUID 异内容：拒绝并返回 QUESTION_CONFLICT', async () => {
    aiConversationService.lockConversationForWrite.mockResolvedValue(lockSnapshot());
    aiConversationService.findQuestionByUuid.mockResolvedValue({
      id: 21,
      conversationId: 7,
      questionUuid: QUESTION_UUID,
      messageSeq: 5,
      turnNo: 3,
      contentText: '另一个问题',
      contentVersion: 1,
      createdAt: new Date('2026-11-18T10:00:00.000Z'),
    });

    await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
      code: AI_CONVERSATION_ERROR.QUESTION_CONFLICT,
    });
    expect(aiConversationService.insertUserMessage).not.toHaveBeenCalled();
  });

  it('并发撞键（事务内唯一冲突）后回读先到者事实并标记回放', async () => {
    aiConversationService.lockConversationForWrite.mockResolvedValue(lockSnapshot());
    aiConversationService.findQuestionByUuid
      // 事务内未读到（先到者尚未提交）
      .mockResolvedValueOnce(null)
      // 回滚后回读命中
      .mockResolvedValueOnce({
        id: 21,
        conversationId: 7,
        questionUuid: QUESTION_UUID,
        messageSeq: 5,
        turnNo: 3,
        contentText: '对准偏差 3μm 如何排查？',
        contentVersion: 1,
        createdAt: new Date('2026-11-18T10:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: 21,
        conversationId: 7,
        questionUuid: QUESTION_UUID,
        messageSeq: 5,
        turnNo: 3,
        contentText: '对准偏差 3μm 如何排查？',
        contentVersion: 1,
        createdAt: new Date('2026-11-18T10:00:00.000Z'),
      });
    aiConversationService.getSequenceFacts.mockResolvedValue({ maxMessageSeq: 4, maxTurnNo: 2 });
    aiConversationService.insertUserMessage.mockRejectedValue(
      new DomainError(AI_CONVERSATION_ERROR.QUESTION_CONFLICT, '该问题标识已被占用'),
    );
    aiConversationService.findAnalysisByQuestion.mockResolvedValue({
      questionUuid: QUESTION_UUID,
      conversationId: 7,
      questionMessageId: 21,
      answerMessageId: null,
      status: AiMessageAnalysisStatus.PENDING,
      failureReason: null,
      contentVersion: 4,
      savedAt: new Date('2026-11-18T10:00:00.000Z'),
      completedAt: null,
    });

    const result = await usecase.execute(buildCommand());

    expect(result.replayed).toBe(true);
    expect(result.messageSeq).toBe(5);
    // 版本推进发生在写入之前，但随事务回滚；分析记录未写入即无半受理
    expect(aiConversationService.insertAnalysis).not.toHaveBeenCalled();
  });

  it('非会话所有者：按不存在拒绝（同公司可读不等于可续写）', async () => {
    aiConversationService.lockConversationForWrite.mockResolvedValue(
      lockSnapshot({ engineerAccountId: 11 }),
    );

    await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
      code: AI_CONVERSATION_ERROR.NOT_FOUND,
    });
    expect(aiConversationService.insertUserMessage).not.toHaveBeenCalled();
  });

  it('F01：工单可信服务公司已变更（当前公司≠工单服务公司）时拒绝且零写入', async () => {
    aiConversationService.lockConversationForWrite.mockResolvedValue(
      lockSnapshot({ requestId: 900 }),
    );
    repairRequestQueryService.findAssociationTarget.mockResolvedValue({
      id: 900,
      requestNo: 'RR-900',
      trustedServiceOrganizationId: 3,
      deletedAt: null,
      isHistorical: false,
    });

    await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
      code: AI_CONVERSATION_ERROR.NOT_FOUND,
    });
    expect(aiConversationService.insertUserMessage).not.toHaveBeenCalled();
    expect(aiConversationService.insertAnalysis).not.toHaveBeenCalled();
    expect(dispatchUsecase.prepareWithinTransaction).not.toHaveBeenCalled();
  });

  it('F01：成员关系变更后（会话归属公司≠当前公司）拒绝工单会话提问', async () => {
    aiConversationService.lockConversationForWrite.mockResolvedValue(
      lockSnapshot({ requestId: 900, ownerOrganizationId: 3 }),
    );
    repairRequestQueryService.findAssociationTarget.mockResolvedValue({
      id: 900,
      requestNo: 'RR-900',
      trustedServiceOrganizationId: 3,
      deletedAt: null,
      isHistorical: false,
    });

    await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
      code: AI_CONVERSATION_ERROR.NOT_FOUND,
    });
    expect(aiConversationService.insertUserMessage).not.toHaveBeenCalled();
  });

  it('F01 对照：工单未删除且可信服务公司一致时仍可正常提问', async () => {
    aiConversationService.lockConversationForWrite.mockResolvedValue(
      lockSnapshot({ requestId: 900 }),
    );
    aiConversationService.findQuestionByUuid.mockResolvedValue(null);
    aiConversationService.getSequenceFacts.mockResolvedValue({ maxMessageSeq: 4, maxTurnNo: 2 });
    aiConversationService.insertUserMessage.mockResolvedValue({
      id: 21,
      conversationId: 7,
      questionUuid: QUESTION_UUID,
      messageSeq: 5,
      turnNo: 3,
      contentText: '对准偏差 3μm 如何排查？',
      contentVersion: 4,
      createdAt: new Date('2026-11-18T10:00:00.000Z'),
    });
    aiConversationService.bumpContentVersion.mockResolvedValue(4);
    aiConversationService.insertAnalysis.mockResolvedValue({
      questionUuid: QUESTION_UUID,
      conversationId: 7,
      questionMessageId: 21,
      answerMessageId: null,
      status: AiMessageAnalysisStatus.PENDING,
      failureReason: null,
      contentVersion: 4,
      savedAt: new Date('2026-11-18T10:00:00.000Z'),
      completedAt: null,
    });
    repairRequestQueryService.findAssociationTarget.mockResolvedValue({
      id: 900,
      requestNo: 'RR-900',
      trustedServiceOrganizationId: 2,
      deletedAt: null,
      isHistorical: false,
    });

    await expect(usecase.execute(buildCommand())).resolves.toMatchObject({
      replayed: false,
      conversationId: 7,
    });
    expect(aiConversationService.insertUserMessage).toHaveBeenCalledTimes(1);
  });

  it('已达到 100 轮：返回 TURN_LIMIT_REACHED 且不写库', async () => {
    aiConversationService.lockConversationForWrite.mockResolvedValue(lockSnapshot());
    aiConversationService.findQuestionByUuid.mockResolvedValue(null);
    aiConversationService.getSequenceFacts.mockResolvedValue({
      maxMessageSeq: 200,
      maxTurnNo: 100,
    });

    await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
      code: AI_CONVERSATION_ERROR.TURN_LIMIT_REACHED,
    });
    expect(aiConversationService.insertUserMessage).not.toHaveBeenCalled();
  });

  it('会话不存在：返回 NOT_FOUND', async () => {
    aiConversationService.lockConversationForWrite.mockResolvedValue(null);

    await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
      code: AI_CONVERSATION_ERROR.NOT_FOUND,
    });
  });

  it('非法 UUID 与超长正文在进入事务前拒绝', async () => {
    await expect(
      usecase.execute(buildCommand({ questionUuid: 'not-a-uuid' })),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.INVALID_PARAMS });
    await expect(
      usecase.execute(buildCommand({ question: '问'.repeat(2001) })),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.INVALID_PARAMS });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });

  it('分析写入失败：错误原样上抛，不回读重放（半受理不得伪装成成功）', async () => {
    aiConversationService.lockConversationForWrite.mockResolvedValue(lockSnapshot());
    aiConversationService.findQuestionByUuid.mockResolvedValue(null);
    aiConversationService.getSequenceFacts.mockResolvedValue({ maxMessageSeq: 4, maxTurnNo: 2 });
    aiConversationService.bumpContentVersion.mockResolvedValue(4);
    aiConversationService.insertUserMessage.mockResolvedValue({
      id: 21,
      conversationId: 7,
      questionUuid: QUESTION_UUID,
      messageSeq: 5,
      turnNo: 3,
      contentText: '对准偏差 3μm 如何排查？',
      contentVersion: 4,
      createdAt: new Date('2026-11-18T10:00:00.000Z'),
    });
    aiConversationService.insertAnalysis.mockRejectedValue(
      new DomainError(AI_CONVERSATION_ERROR.SUBMIT_FAILED, 'AI 问题受理失败，请稍后重试'),
    );

    await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
      code: AI_CONVERSATION_ERROR.SUBMIT_FAILED,
    });
    // 事务边界由 TransactionRunner 负责整体回滚；用例不得把失败重读成分析事实
    expect(aiConversationService.findAnalysisByQuestion).not.toHaveBeenCalled();
    expect(transactionRunner.run).toHaveBeenCalledTimes(1);
  });

  it('跨会话复用同一 UUID：正文相同也按冲突拒绝（不得回放他人会话事实）', async () => {
    aiConversationService.lockConversationForWrite.mockResolvedValue(lockSnapshot());
    aiConversationService.findQuestionByUuid.mockResolvedValue({
      id: 31,
      conversationId: 8,
      questionUuid: QUESTION_UUID,
      messageSeq: 1,
      turnNo: 1,
      contentText: '对准偏差 3μm 如何排查？',
      contentVersion: 2,
      createdAt: new Date('2026-11-18T10:00:00.000Z'),
    });

    await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
      code: AI_CONVERSATION_ERROR.QUESTION_CONFLICT,
    });
    expect(aiConversationService.insertUserMessage).not.toHaveBeenCalled();
  });

  it('非工程师身份（activeRole 非 ENGINEER）：拒绝且不进入事务', async () => {
    await expect(
      usecase.execute({
        ...buildCommand(),
        session: {
          accountId: 1,
          roles: [IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN],
          activeRole: IdentityTypeEnum.SUPER_ADMIN,
        },
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });
});
