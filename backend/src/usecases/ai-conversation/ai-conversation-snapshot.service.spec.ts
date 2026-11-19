// src/usecases/ai-conversation/ai-conversation-snapshot.service.spec.ts
// 任务05 F05：固定范围导出的版本语义（不静默降级、按版本截断）。

import { AI_CONVERSATION_ERROR } from '@core/common/errors/domain-error';
import type { AiConversationQueryService } from '@src/modules/lithography/queries/ai-conversation.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';

import { AiConversationSnapshotService } from './ai-conversation-snapshot.service';

const SESSION = {
  accountId: 10,
  activeRole: 'ENGINEER',
  roles: ['ENGINEER'],
  accessTokenId: 't-1',
} as unknown as Parameters<AiConversationSnapshotService['resolveReadableSnapshot']>[0]['session'];

const DETAIL = {
  id: 7,
  requestId: null,
  requestNo: 'REQ-7',
  ownerAccountId: 10,
  ownerOrganizationId: 2,
  contentVersion: 3,
  createdAt: new Date('2026-11-18T09:00:00.000Z'),
  messages: [
    {
      id: 1,
      messageSeq: 1,
      turnNo: 1,
      role: 'USER',
      contentText: '问题一',
      contentVersion: 1,
      createdAt: new Date('2026-11-18T09:01:00.000Z'),
    },
    {
      id: 2,
      messageSeq: 2,
      turnNo: 1,
      role: 'ASSISTANT',
      contentText: '回答一',
      contentVersion: 2,
      createdAt: new Date('2026-11-18T09:02:00.000Z'),
    },
    {
      id: 3,
      messageSeq: 3,
      turnNo: 2,
      role: 'USER',
      contentText: '问题二',
      contentVersion: 3,
      createdAt: new Date('2026-11-18T09:03:00.000Z'),
    },
  ],
  analyses: [
    { questionMessageId: 1, status: 'SUCCEEDED', failureReason: null },
    { questionMessageId: 3, status: 'PENDING', failureReason: null },
  ],
  messageTurnNos: new Map<number, number | null>([
    [1, 1],
    [3, 2],
  ]),
};

describe('AiConversationSnapshotService（F05 固定范围）', () => {
  let queryService: { findVisibleDetail: jest.Mock };
  let service: AiConversationSnapshotService;

  beforeEach(() => {
    queryService = { findVisibleDetail: jest.fn().mockResolvedValue(DETAIL) };
    service = new AiConversationSnapshotService(
      queryService as unknown as AiConversationQueryService,
      {
        tryResolveForAccount: jest.fn().mockResolvedValue({ organizationId: 2 }),
      } as unknown as TrustedOrganizationContextQueryService,
      {
        findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map([[10, '工程师 A']])),
      } as unknown as AccountQueryService,
    );
  });

  it('请求版本高于当前版本：显式拒绝，不静默降级', async () => {
    await expect(
      service.resolveReadableSnapshot({ session: SESSION, conversationId: 7, contentVersion: 4 }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.INVALID_PARAMS });
  });

  it('按选定版本截断：v2 只含前两条消息，截止序号为 2', async () => {
    const snapshot = await service.resolveReadableSnapshot({
      session: SESSION,
      conversationId: 7,
      contentVersion: 2,
    });

    expect(snapshot.contentVersion).toBe(2);
    expect(snapshot.messages.map((message) => message.messageSeq)).toEqual([1, 2]);
    expect(snapshot.lastMessageSeq).toBe(2);
  });

  it('后续写入不改变已选版本范围（同版本重复导出结果一致）', async () => {
    const first = await service.resolveReadableSnapshot({
      session: SESSION,
      conversationId: 7,
      contentVersion: 2,
    });
    // 模拟此后又写入新消息（版本推进），同一请求版本仍只看到 v2 范围
    queryService.findVisibleDetail.mockResolvedValue({
      ...DETAIL,
      contentVersion: 5,
      messages: [
        ...DETAIL.messages,
        {
          id: 4,
          messageSeq: 4,
          turnNo: 2,
          role: 'ASSISTANT',
          contentText: '回答二',
          contentVersion: 5,
          createdAt: new Date('2026-11-18T09:04:00.000Z'),
        },
      ],
    });

    const second = await service.resolveReadableSnapshot({
      session: SESSION,
      conversationId: 7,
      contentVersion: 2,
    });

    expect(second.lastMessageSeq).toBe(first.lastMessageSeq);
    expect(second.messages.map((message) => message.messageId)).toEqual(
      first.messages.map((message) => message.messageId),
    );
  });

  it('截止在中间态时如实标记轮次状态（半轮不美化）', async () => {
    const snapshot = await service.resolveReadableSnapshot({
      session: SESSION,
      conversationId: 7,
      contentVersion: 3,
    });

    const secondTurnQuestion = snapshot.messages.find((message) => message.messageSeq === 3);
    expect(secondTurnQuestion?.turnState).toBe('PENDING');
  });
});
