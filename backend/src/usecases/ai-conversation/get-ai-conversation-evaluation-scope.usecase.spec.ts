// src/usecases/ai-conversation/get-ai-conversation-evaluation-scope.usecase.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { AI_CONVERSATION_ERROR } from '@core/common/errors/domain-error';

import type { AiConversationSnapshotService } from './ai-conversation-snapshot.service';
import { GetAiConversationEvaluationScopeUsecase } from './get-ai-conversation-evaluation-scope.usecase';

/**
 * 关联会话固定评价范围用例单测（任务 05 · S4.3）。
 *
 * 覆盖：固定版本与消息截止点、有效回复只含已成功保存的回答、
 * 失败轮次不计入有效回复、越权读取与非法入参在读取前拒绝。
 */
describe('GetAiConversationEvaluationScopeUsecase', () => {
  const ENGINEER_SESSION: UsecaseSession = {
    accountId: 10,
    roles: [IdentityTypeEnum.ENGINEER],
    activeRole: IdentityTypeEnum.ENGINEER,
  };

  const snapshot = {
    conversationId: 66,
    contentVersion: 2,
    lastMessageSeq: 4,
    requestId: 88,
    requestNo: 'RR-20261101-001',
    engineerNickname: '陈工程师',
    createdAt: '2026-11-01T00:00:00.000Z',
    messages: [
      {
        messageId: 1,
        messageSeq: 1,
        turnNo: 1,
        role: 'USER',
        text: '问题正文',
        contentVersion: 1,
        createdAt: '2026-11-01T00:00:00.000Z',
        turnState: 'SUCCEEDED' as const,
      },
      {
        messageId: 2,
        messageSeq: 2,
        turnNo: 1,
        role: 'ASSISTANT',
        text: '有效回答',
        contentVersion: 1,
        createdAt: '2026-11-01T00:00:01.000Z',
        turnState: 'SUCCEEDED' as const,
      },
      {
        messageId: 3,
        messageSeq: 3,
        turnNo: 2,
        role: 'USER',
        text: '第二个问题',
        contentVersion: 2,
        createdAt: '2026-11-01T00:00:02.000Z',
        turnState: 'FAILED' as const,
      },
      {
        messageId: 4,
        messageSeq: 4,
        turnNo: 2,
        role: 'ASSISTANT',
        text: '失败轮次的残留文本',
        contentVersion: 2,
        createdAt: '2026-11-01T00:00:03.000Z',
        turnState: 'FAILED' as const,
      },
    ],
  };

  const snapshotService = {
    resolveReadableSnapshot: jest.fn(),
  } as unknown as AiConversationSnapshotService;

  const usecase = new GetAiConversationEvaluationScopeUsecase(snapshotService);

  beforeEach(() => {
    (snapshotService.resolveReadableSnapshot as jest.Mock).mockReset().mockResolvedValue(snapshot);
  });

  it('固定消息截止点与内容版本，并只返回已成功保存的有效回复', async () => {
    const view = await usecase.execute({
      session: ENGINEER_SESSION,
      conversationId: 66,
      contentVersion: 2,
    });

    expect(view.contentVersion).toBe(2);
    expect(view.lastMessageSeq).toBe(4);
    expect(view.requestNo).toBe('RR-20261101-001');
    expect(view.replies).toHaveLength(1);
    expect(view.replies[0]).toMatchObject({
      messageId: 2,
      messageSeq: 2,
      turnNo: 1,
      contentVersion: 1,
      analysisStatus: 'SUCCEEDED',
      text: '有效回答',
    });
  });

  it('以显式选定的版本读取固定范围（不随后续追加消息漂移）', async () => {
    await usecase.execute({ session: ENGINEER_SESSION, conversationId: 66, contentVersion: 1 });

    expect(snapshotService.resolveReadableSnapshot).toHaveBeenCalledWith({
      session: ENGINEER_SESSION,
      conversationId: 66,
      contentVersion: 1,
      actionLabel: '读取评价范围',
    });
  });

  it('越权读取（会话不可见）按不存在拒绝', async () => {
    (snapshotService.resolveReadableSnapshot as jest.Mock).mockRejectedValue(
      new (await import('@core/common/errors/domain-error')).DomainError(
        AI_CONVERSATION_ERROR.NOT_FOUND,
        '会话不存在或无权访问',
      ),
    );

    await expect(
      usecase.execute({ session: ENGINEER_SESSION, conversationId: 66, contentVersion: 1 }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.NOT_FOUND });
  });

  it('非法会话标识与内容版本在读取前拒绝', async () => {
    await expect(
      usecase.execute({ session: ENGINEER_SESSION, conversationId: 0, contentVersion: 1 }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.INVALID_PARAMS });
    await expect(
      usecase.execute({ session: ENGINEER_SESSION, conversationId: 66, contentVersion: 0 }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.INVALID_PARAMS });
    expect(snapshotService.resolveReadableSnapshot).not.toHaveBeenCalled();
  });
});
