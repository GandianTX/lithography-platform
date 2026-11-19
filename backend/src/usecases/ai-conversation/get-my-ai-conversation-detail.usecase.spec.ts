/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  AiConversationStatus,
  AiMessageAnalysisStatus,
  AiMessageRole,
} from '@app-types/models/ai-conversation.types';
import { AI_CONVERSATION_ERROR } from '@src/core/common/errors/domain-error';
import type { AiConversationQueryService } from '@src/modules/lithography/queries/ai-conversation.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { GetMyAiConversationDetailUsecase } from './get-my-ai-conversation-detail.usecase';

type QueryServiceMock = { findVisibleDetail: jest.Mock };
type OrganizationContextMock = { resolveForAccount: jest.Mock; tryResolveForAccount: jest.Mock };

const ENGINEER_SESSION: UsecaseSession = {
  accountId: 10,
  roles: [IdentityTypeEnum.ENGINEER],
  activeRole: IdentityTypeEnum.ENGINEER,
};

const QUESTION_1 = '3f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const QUESTION_2 = '4f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const createdAt = new Date('2026-11-18T10:00:00.000Z');

describe('GetMyAiConversationDetailUsecase', () => {
  let queryService: QueryServiceMock;
  let organizationContextService: OrganizationContextMock;
  let usecase: GetMyAiConversationDetailUsecase;

  beforeEach(() => {
    queryService = { findVisibleDetail: jest.fn() };
    organizationContextService = {
      resolveForAccount: jest.fn(),
      tryResolveForAccount: jest
        .fn()
        .mockResolvedValue({ organizationId: 2, memberRole: 'ENGINEER' }),
    };
    usecase = new GetMyAiConversationDetailUsecase(
      queryService as unknown as AiConversationQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
    );
  });

  it('不可见（他人独立会话）与不存在统一按 NOT_FOUND 拒绝', async () => {
    queryService.findVisibleDetail.mockResolvedValue(null);

    await expect(
      usecase.execute({ session: ENGINEER_SESSION, conversationId: 9 }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.NOT_FOUND });
    expect(organizationContextService.tryResolveForAccount).toHaveBeenCalledWith({
      accountId: 10,
    });
  });

  it('按 question_uuid 组装轮次：成功轮有回答，失败轮只有状态与原因', async () => {
    queryService.findVisibleDetail.mockResolvedValue({
      id: 7,
      requestId: 5,
      requestNo: 'DEV-RR-A-102',
      status: AiConversationStatus.ACTIVE,
      contentVersion: 5,
      createdAt,
      completedAt: null,
      messages: [
        {
          id: 1,
          messageSeq: 1,
          turnNo: 1,
          role: AiMessageRole.USER,
          questionUuid: QUESTION_1,
          contentText: '第一问',
          contentVersion: 1,
          createdAt,
        },
        {
          id: 2,
          messageSeq: 2,
          turnNo: 1,
          role: AiMessageRole.ASSISTANT,
          questionUuid: null,
          contentText: '第一答',
          contentVersion: 1,
          createdAt,
        },
        {
          id: 3,
          messageSeq: 3,
          turnNo: 2,
          role: AiMessageRole.USER,
          questionUuid: QUESTION_2,
          contentText: '第二问',
          contentVersion: 1,
          createdAt,
        },
      ],
      analyses: [
        {
          questionUuid: QUESTION_1,
          conversationId: 7,
          questionMessageId: 1,
          answerMessageId: 2,
          status: AiMessageAnalysisStatus.SUCCEEDED,
          failureReason: null,
          contentVersion: 3,
          savedAt: createdAt,
          completedAt: createdAt,
        },
        {
          questionUuid: QUESTION_2,
          conversationId: 7,
          questionMessageId: 3,
          answerMessageId: null,
          status: AiMessageAnalysisStatus.FAILED,
          failureReason: 'model_timeout',
          contentVersion: 4,
          savedAt: createdAt,
          completedAt: createdAt,
        },
      ],
    });

    const detail = await usecase.execute({ session: ENGINEER_SESSION, conversationId: 7 });

    expect(detail.requestNo).toBe('DEV-RR-A-102');
    expect(detail.turns).toHaveLength(2);
    expect(detail.turns[0]).toMatchObject({
      questionUuid: QUESTION_1,
      analysisStatus: AiMessageAnalysisStatus.SUCCEEDED,
      answer: { messageId: 2, text: '第一答' },
    });
    expect(detail.turns[1]).toMatchObject({
      questionUuid: QUESTION_2,
      analysisStatus: AiMessageAnalysisStatus.FAILED,
      failureReason: 'model_timeout',
      answer: null,
    });
    expect(detail.turns[1].question).toMatchObject({ messageId: 3, text: '第二问' });
  });

  it('无分析记录的历史问题不猜状态（analysisStatus 为 null）', async () => {
    queryService.findVisibleDetail.mockResolvedValue({
      id: 8,
      requestId: null,
      requestNo: '',
      status: AiConversationStatus.ACTIVE,
      contentVersion: 1,
      createdAt,
      completedAt: null,
      messages: [
        {
          id: 1,
          messageSeq: 1,
          turnNo: 1,
          role: AiMessageRole.USER,
          questionUuid: QUESTION_1,
          contentText: '历史问题',
          contentVersion: 1,
          createdAt,
        },
      ],
      analyses: [],
    });

    const detail = await usecase.execute({ session: ENGINEER_SESSION, conversationId: 8 });

    expect(detail.turns[0]).toMatchObject({
      questionUuid: QUESTION_1,
      analysisStatus: null,
      failureReason: null,
      answer: null,
    });
  });
});
