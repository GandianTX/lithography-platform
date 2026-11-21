// src/modules/lithography/queries/ai-conversation.query.service.spec.ts
// 任务05 F01：工程师会话读侧可见性条件（与 core 策略等价）的回归。

import type { AiConversationViewerScope } from '../ai-conversation.types';
import {
  AiConversationQueryService,
  buildEngineerVisibilityClauses,
} from './ai-conversation.query.service';

describe('AiConversationQueryService 工程师可见性（F01）', () => {
  const pagination = { page: 1, pageSize: 10, withTotal: true };
  const viewer: AiConversationViewerScope = { accountId: 10, organizationId: 2 };

  const makeQbStub = () => {
    const qb: Record<string, jest.Mock> = {
      leftJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      clone: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
    };
    qb.getMany = jest.fn().mockResolvedValue([]);
    qb.getCount = jest.fn().mockResolvedValue(0);
    qb.getOne = jest.fn().mockResolvedValue(null);
    qb.getRawMany = jest.fn().mockResolvedValue([]);
    return qb;
  };

  const makeService = (
    qb: Record<string, jest.Mock>,
    messageRepository?: Record<string, jest.Mock>,
  ) =>
    new AiConversationQueryService(
      { createQueryBuilder: jest.fn().mockReturnValue(qb) } as never,
      (messageRepository ?? { find: jest.fn().mockResolvedValue([]) }) as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      { findOne: jest.fn().mockResolvedValue(null), find: jest.fn() } as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
    );

  describe('条件集合', () => {
    it('工单会话同时要求归属公司、未删除与可信服务公司一致（AUTH-01／02 的 SQL 侧）', () => {
      const clauses = buildEngineerVisibilityClauses(2);
      expect(clauses.independent).toEqual([
        'conversation.requestId IS NULL',
        'conversation.engineerAccountId = :viewerAccountId',
      ]);
      expect(clauses.workOrder).toEqual([
        'conversation.requestId IS NOT NULL',
        'conversation.ownerOrganizationId = :viewerOrganizationId',
        'request.deletedAt IS NULL',
        'request.serviceOrganizationId = :viewerOrganizationId',
        'intake.serviceOrganizationId IS NOT NULL',
        'intake.serviceOrganizationId = request.serviceOrganizationId',
      ]);
    });

    it('查看者无公司归属时不生成工单会话分支（只保留本人独立会话）', () => {
      const clauses = buildEngineerVisibilityClauses(null);
      expect(clauses.workOrder).toBeNull();
      expect(clauses.independent).toHaveLength(2);
    });
  });

  describe('查询装配', () => {
    it('列表：关联工单与 intake，并注入可见性条件与参数', async () => {
      const qb = makeQbStub();
      await makeService(qb).listVisible({ viewer, pagination });

      const joinedTables = qb.leftJoin.mock.calls.map((call) => call[1]);
      expect(joinedTables).toEqual(['request', 'intake']);
      expect(qb.andWhere).toHaveBeenCalledTimes(1);
      expect(qb.setParameters).toHaveBeenCalledWith({
        viewerAccountId: 10,
        viewerOrganizationId: 2,
      });
    });

    it('详情与状态头读取使用同一可见性装配（不存在两套口径）', async () => {
      const detailQb = makeQbStub();
      await makeService(detailQb).findVisibleDetail({ conversationId: 7, viewer });

      const headerQb = makeQbStub();
      await makeService(headerQb).findVisibleHeader({ conversationId: 7, viewer });

      expect(detailQb.leftJoin.mock.calls.map((call) => call[1])).toEqual(
        headerQb.leftJoin.mock.calls.map((call) => call[1]),
      );
      expect(detailQb.setParameters.mock.calls).toEqual(headerQb.setParameters.mock.calls);
      expect(detailQb.andWhere).toHaveBeenCalledTimes(headerQb.andWhere.mock.calls.length);
    });
  });

  describe('列表装配：真实轮次（turnCount）', () => {
    const conversationEntity = {
      id: 7,
      requestId: null,
      status: 'COMPLETED',
      contentVersion: 1,
      createdAt: new Date('2026-11-20T08:00:00.000Z'),
      completedAt: null,
    };

    it('按 turn_no 去重计数，而不是消息条数', async () => {
      const conversationQb = makeQbStub();
      conversationQb.getMany.mockResolvedValue([conversationEntity]);
      const messageQb = makeQbStub();
      messageQb.getRawMany.mockResolvedValue([
        { conversationId: 7, count: '5', lastMessageAt: new Date(), turnCount: '3' },
      ]);

      const page = await makeService(conversationQb, {
        createQueryBuilder: jest.fn().mockReturnValue(messageQb),
      }).listVisible({ viewer, pagination });

      expect(page.items[0].turnCount).toBe(3);
      expect(page.items[0].messageCount).toBe(5);
      // 聚合口径：真实轮次按 turn_no 去重（失败轮只有用户消息也计为一轮）
      expect(messageQb.addSelect).toHaveBeenCalledWith(
        'COUNT(DISTINCT message.turnNo)',
        'turnCount',
      );
    });

    it('会话没有任何消息时轮次为 0', async () => {
      const conversationQb = makeQbStub();
      conversationQb.getMany.mockResolvedValue([conversationEntity]);
      const messageQb = makeQbStub();
      messageQb.getRawMany.mockResolvedValue([]);

      const page = await makeService(conversationQb, {
        createQueryBuilder: jest.fn().mockReturnValue(messageQb),
      }).listVisible({ viewer, pagination });

      expect(page.items[0].turnCount).toBe(0);
      expect(page.items[0].messageCount).toBe(0);
    });
  });
});
