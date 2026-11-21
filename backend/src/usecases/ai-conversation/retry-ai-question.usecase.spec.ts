// src/usecases/ai-conversation/retry-ai-question.usecase.spec.ts
/// <reference types="jest" />

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  AiConversationStatus,
  AiMessageAnalysisStatus,
} from '@app-types/models/ai-conversation.types';
import { AI_CONVERSATION_ERROR } from '@src/core/common/errors/domain-error';
import type { AiConversationService } from '@src/modules/lithography/ai-conversation.service';
import type { RepairRequestQueryService } from '@src/modules/lithography/queries/repair-request.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';

import type { DispatchAiQuestionUsecase } from './dispatch-ai-question.usecase';
import { RetryAiQuestionUsecase } from './retry-ai-question.usecase';

const QUESTION_UUID = '3f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';

const ENGINEER_SESSION: UsecaseSession = {
  accountId: 10,
  roles: [IdentityTypeEnum.ENGINEER],
  activeRole: IdentityTypeEnum.ENGINEER,
};

describe('RetryAiQuestionUsecase', () => {
  const transactionContext = Symbol('tx') as unknown as PersistenceTransactionContext;

  let aiConversationService: Record<string, jest.Mock>;
  let repairRequestQueryService: { findAssociationTarget: jest.Mock };
  let organizationContextService: { resolveForAccount: jest.Mock; tryResolveForAccount: jest.Mock };
  let dispatchUsecase: { prepareWithinTransaction: jest.Mock; admitPrepared: jest.Mock };
  let transactionRunner: TransactionRunner;
  let usecase: RetryAiQuestionUsecase;

  beforeEach(() => {
    aiConversationService = {
      lockConversationForWrite: jest.fn(),
      findAnalysisByQuestion: jest.fn(),
      findQuestionByUuid: jest.fn(),
      resetAnalysisForRetry: jest.fn().mockResolvedValue(true),
    };
    organizationContextService = {
      resolveForAccount: jest.fn().mockResolvedValue({ organizationId: 2, memberRole: 'ENGINEER' }),
      tryResolveForAccount: jest.fn(),
    };
    repairRequestQueryService = {
      findAssociationTarget: jest.fn().mockResolvedValue(null),
    };
    dispatchUsecase = {
      prepareWithinTransaction: jest
        .fn()
        .mockResolvedValue({ status: 'PREPARED', workflowId: 'wf-2' }),
      admitPrepared: jest
        .fn()
        .mockResolvedValue({ status: 'QUEUED', workflowId: 'wf-2', jobId: 'job-2' }),
    };
    transactionRunner = {
      run: jest.fn(async (work: (context: PersistenceTransactionContext) => Promise<unknown>) =>
        work(transactionContext),
      ),
    } as unknown as TransactionRunner;

    usecase = new RetryAiQuestionUsecase(
      aiConversationService as unknown as AiConversationService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      repairRequestQueryService as unknown as RepairRequestQueryService,
      dispatchUsecase as unknown as DispatchAiQuestionUsecase,
      transactionRunner,
    );
  });

  const lockSnapshot = () => ({
    id: 7,
    requestId: null,
    ownerOrganizationId: 2,
    contentVersion: 3,
    engineerAccountId: 10,
    status: AiConversationStatus.ACTIVE,
  });

  const command = () => ({
    session: ENGINEER_SESSION,
    conversationId: 7,
    questionUuid: QUESTION_UUID,
    stage: 2,
  });

  it('失败轮次重试：重置为 PENDING 并重新派发（沿用同一问题 UUID）', async () => {
    aiConversationService.lockConversationForWrite.mockResolvedValue(lockSnapshot());
    aiConversationService.findAnalysisByQuestion.mockResolvedValue({
      questionUuid: QUESTION_UUID,
      conversationId: 7,
      status: AiMessageAnalysisStatus.FAILED,
      failureReason: 'reply_timeout',
      answerMessageId: null,
      contentVersion: 3,
    });
    aiConversationService.findQuestionByUuid.mockResolvedValue({
      id: 5,
      conversationId: 7,
      questionUuid: QUESTION_UUID,
      messageSeq: 5,
      turnNo: 3,
      contentText: '对准偏差如何排查？',
      contentVersion: 3,
      createdAt: new Date(),
    });

    const result = await usecase.execute(command());

    expect(result).toMatchObject({
      conversationId: 7,
      questionUuid: QUESTION_UUID,
      status: AiMessageAnalysisStatus.PENDING,
      turnNo: 3,
      messageSeq: 5,
      contentVersion: 3,
      replayed: false,
      dispatchStatus: 'QUEUED',
    });
    expect(aiConversationService.resetAnalysisForRetry).toHaveBeenCalledWith(
      { questionUuid: QUESTION_UUID },
      transactionContext,
    );
    // B1：重置为 PENDING 与新执行事实同一事务，投递在提交之后
    expect(dispatchUsecase.prepareWithinTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 7,
        questionUuid: QUESTION_UUID,
        questionText: '对准偏差如何排查？',
        turnNo: 3,
        contentVersion: 3,
        stage: 2,
      }),
      transactionContext,
    );
    expect(dispatchUsecase.admitPrepared).toHaveBeenCalledWith({ workflowId: 'wf-2' });
  });

  it('成功轮次不可重试', async () => {
    aiConversationService.lockConversationForWrite.mockResolvedValue(lockSnapshot());
    aiConversationService.findAnalysisByQuestion.mockResolvedValue({
      questionUuid: QUESTION_UUID,
      conversationId: 7,
      status: AiMessageAnalysisStatus.SUCCEEDED,
      answerMessageId: 42,
      contentVersion: 3,
    });
    aiConversationService.findQuestionByUuid.mockResolvedValue({
      id: 5,
      conversationId: 7,
      questionUuid: QUESTION_UUID,
      messageSeq: 5,
      turnNo: 3,
      contentText: '对准偏差如何排查？',
      contentVersion: 3,
      createdAt: new Date(),
    });

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: AI_CONVERSATION_ERROR.RETRY_NOT_ALLOWED,
    });
    expect(aiConversationService.resetAnalysisForRetry).not.toHaveBeenCalled();
    expect(dispatchUsecase.prepareWithinTransaction).not.toHaveBeenCalled();
  });

  it('并发重试撞车（重置未命中）拒绝且不派发', async () => {
    aiConversationService.lockConversationForWrite.mockResolvedValue(lockSnapshot());
    aiConversationService.findAnalysisByQuestion.mockResolvedValue({
      questionUuid: QUESTION_UUID,
      conversationId: 7,
      status: AiMessageAnalysisStatus.FAILED,
      failureReason: 'reply_timeout',
      answerMessageId: null,
      contentVersion: 3,
    });
    aiConversationService.findQuestionByUuid.mockResolvedValue({
      id: 5,
      conversationId: 7,
      questionUuid: QUESTION_UUID,
      messageSeq: 5,
      turnNo: 3,
      contentText: '对准偏差如何排查？',
      contentVersion: 3,
      createdAt: new Date(),
    });
    aiConversationService.resetAnalysisForRetry.mockResolvedValue(false);

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: AI_CONVERSATION_ERROR.RETRY_NOT_ALLOWED,
    });
    expect(dispatchUsecase.prepareWithinTransaction).not.toHaveBeenCalled();
  });

  it('F04：上一执行尚未收尾（EXISTING_ACTIVE）时拒绝本次重试', async () => {
    aiConversationService.lockConversationForWrite.mockResolvedValue(lockSnapshot());
    aiConversationService.findAnalysisByQuestion.mockResolvedValue({
      questionUuid: QUESTION_UUID,
      conversationId: 7,
      status: AiMessageAnalysisStatus.FAILED,
      failureReason: 'reply_timeout',
      answerMessageId: null,
      contentVersion: 3,
    });
    aiConversationService.findQuestionByUuid.mockResolvedValue({
      id: 5,
      conversationId: 7,
      questionUuid: QUESTION_UUID,
      messageSeq: 5,
      turnNo: 3,
      contentText: '对准偏差如何排查？',
      contentVersion: 3,
      createdAt: new Date(),
    });
    dispatchUsecase.prepareWithinTransaction.mockResolvedValue({
      status: 'EXISTING_ACTIVE',
      workflowId: 'wf-old',
    });

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: AI_CONVERSATION_ERROR.RETRY_NOT_ALLOWED,
    });
    // 事务整体回滚：不得投递旧执行，也不得把旧执行当成新一次重试成功
    expect(dispatchUsecase.admitPrepared).not.toHaveBeenCalled();
  });

  it('投递失败：保留待准入事实，本轮仍为 PENDING 且 dispatchStatus=DEFERRED', async () => {
    aiConversationService.lockConversationForWrite.mockResolvedValue(lockSnapshot());
    aiConversationService.findAnalysisByQuestion.mockResolvedValue({
      questionUuid: QUESTION_UUID,
      conversationId: 7,
      status: AiMessageAnalysisStatus.FAILED,
      failureReason: 'reply_timeout',
      answerMessageId: null,
      contentVersion: 3,
    });
    aiConversationService.findQuestionByUuid.mockResolvedValue({
      id: 5,
      conversationId: 7,
      questionUuid: QUESTION_UUID,
      messageSeq: 5,
      turnNo: 3,
      contentText: '对准偏差如何排查？',
      contentVersion: 3,
      createdAt: new Date(),
    });
    dispatchUsecase.admitPrepared.mockResolvedValue({
      status: 'DEFERRED',
      workflowId: 'wf-2',
      jobId: null,
    });

    const result = await usecase.execute(command());

    // Q01：投递失败不再把本轮判成失败——待准入事实仍在库内，由 housekeeping 重投
    expect(result).toMatchObject({
      status: AiMessageAnalysisStatus.PENDING,
      dispatchStatus: 'DEFERRED',
    });
  });
});
