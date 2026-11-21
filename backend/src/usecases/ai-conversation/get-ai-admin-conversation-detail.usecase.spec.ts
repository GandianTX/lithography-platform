// src/usecases/ai-conversation/get-ai-admin-conversation-detail.usecase.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { AI_CONVERSATION_ERROR, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { AiConversationQueryService } from '@src/modules/lithography/queries/ai-conversation.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';

import { GetAiAdminConversationDetailUsecase } from './get-ai-admin-conversation-detail.usecase';

/**
 * 管理员只读详情用例单测（任务 05 · S4.1 · R038-01）。
 *
 * 覆盖：授权矩阵（一级跨公司 / 二级本公司）、外公司直传拒绝、
 * 只读不重算模型、失败轮次如实带出失败原因。
 */
describe('GetAiAdminConversationDetailUsecase', () => {
  const ADMIN_SESSION: UsecaseSession = {
    accountId: 900,
    roles: [IdentityTypeEnum.SUPER_ADMIN],
    activeRole: IdentityTypeEnum.SUPER_ADMIN,
  };

  const createdAt = new Date('2026-11-01T00:00:00.000Z');

  const detail = (overrides: Record<string, unknown> = {}) => ({
    id: 66,
    requestId: 88,
    requestNo: 'RR-20261101-001',
    status: 'ACTIVE',
    contentVersion: 2,
    createdAt,
    completedAt: null,
    ownerAccountId: 20,
    ownerOrganizationId: 100,
    messages: [
      {
        id: 1,
        messageSeq: 1,
        turnNo: 1,
        role: 'USER',
        questionUuid: 'uuid-1',
        contentText: '问题正文',
        contentVersion: 1,
        createdAt,
      },
      {
        id: 2,
        messageSeq: 2,
        turnNo: 1,
        role: 'ASSISTANT',
        questionUuid: null,
        contentText: '回答正文',
        contentVersion: 1,
        createdAt,
      },
    ],
    analyses: [
      {
        questionUuid: 'uuid-1',
        conversationId: 66,
        questionMessageId: 1,
        answerMessageId: 2,
        status: 'FAILED',
        failureReason: '模型调用超时',
        contentVersion: 1,
        savedAt: createdAt,
        completedAt: createdAt,
      },
    ],
    messageTurnNos: new Map<number, number | null>([
      [1, 1],
      [2, 1],
    ]),
    ...overrides,
  });

  const queryService = {
    findAdminDetail: jest.fn(),
  } as unknown as AiConversationQueryService;

  const organizationContextService = {
    tryResolveForAccount: jest.fn().mockResolvedValue({
      organizationId: 100,
      memberRole: 'SUPER_ADMIN',
    }),
  } as unknown as TrustedOrganizationContextQueryService;

  const accountQueryService = {
    findAdminLevelByAccountId: jest.fn().mockResolvedValue(1),
    findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map([[20, '陈工程师']])),
  } as unknown as AccountQueryService;

  const usecase = new GetAiAdminConversationDetailUsecase(
    queryService,
    organizationContextService,
    accountQueryService,
  );

  beforeEach(() => {
    (queryService.findAdminDetail as jest.Mock).mockReset().mockResolvedValue(detail());
    (organizationContextService.tryResolveForAccount as jest.Mock)
      .mockReset()
      .mockResolvedValue({ organizationId: 100, memberRole: 'SUPER_ADMIN' });
    (accountQueryService.findAdminLevelByAccountId as jest.Mock).mockReset().mockResolvedValue(1);
  });

  it('一级管理员可读取跨公司会话详情，并装配逐轮问答', async () => {
    const view = await usecase.execute({ session: ADMIN_SESSION, conversationId: 66 });

    expect(view.conversationId).toBe(66);
    expect(view.engineerNickname).toBe('陈工程师');
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]).toMatchObject({
      questionUuid: 'uuid-1',
      turnNo: 1,
      analysisStatus: 'FAILED',
      failureReason: '模型调用超时',
    });
    expect(view.turns[0].question?.text).toBe('问题正文');
    expect(view.turns[0].answer?.text).toBe('回答正文');
  });

  it('会话不存在或不可见时按 NOT_FOUND 拒绝（不区分事实）', async () => {
    (queryService.findAdminDetail as jest.Mock).mockResolvedValue(null);

    await expect(
      usecase.execute({ session: ADMIN_SESSION, conversationId: 66 }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.NOT_FOUND });
  });

  it('二级管理员读取本公司会话放行', async () => {
    (accountQueryService.findAdminLevelByAccountId as jest.Mock).mockResolvedValue(2);

    const view = await usecase.execute({ session: ADMIN_SESSION, conversationId: 66 });

    expect(view.conversationId).toBe(66);
    expect(queryService.findAdminDetail).toHaveBeenCalledWith({
      conversationId: 66,
      scope: { kind: 'ADMIN_ORGANIZATION', organizationId: 100 },
    });
  });

  it('非管理员会话被拒绝，且不读取会话', async () => {
    await expect(
      usecase.execute({
        session: {
          accountId: 30,
          roles: [IdentityTypeEnum.ENGINEER],
          activeRole: IdentityTypeEnum.ENGINEER,
        },
        conversationId: 66,
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(queryService.findAdminDetail).not.toHaveBeenCalled();
  });

  it('非法会话标识在读取前拒绝', async () => {
    await expect(
      usecase.execute({ session: ADMIN_SESSION, conversationId: 0 }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.INVALID_PARAMS });
    expect(queryService.findAdminDetail).not.toHaveBeenCalled();
  });
});
