// src/modules/lithography/queries/admin-ai-message.query.service.spec.ts

import { AdminAiMessageQueryService } from './admin-ai-message.query.service';

/**
 * PR3 S4：管理员 AI 消息读侧 QueryService 单测。
 *
 * 计划表 S4.2 的核心契约：消息严格按 `messageSeq ASC, id ASC` 稳定排序
 * （排序由服务冻结，不采纳客户端排序），100 轮会话可经分页完整顺序读取。
 * 二级管理员（传入 ownerOrganizationId）的会话存在性判断与消息查询必须
 * 使用同一可信组织范围，不区分“存在但无权”和“不存在”。
 */
describe('AdminAiMessageQueryService', () => {
  interface BuilderMock {
    where: jest.Mock;
    innerJoin: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    offset: jest.Mock;
    limit: jest.Mock;
    getMany: jest.Mock;
    getCount: jest.Mock;
  }

  const makeBuilder = (): BuilderMock => {
    const builder = {} as BuilderMock;
    for (const method of [
      'where',
      'innerJoin',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'offset',
      'limit',
    ] as const) {
      builder[method] = jest.fn(() => builder);
    }
    builder.getMany = jest.fn().mockResolvedValue([]);
    builder.getCount = jest.fn().mockResolvedValue(0);
    return builder;
  };

  const makeMessageRepo = (result: { entities?: unknown[]; count?: number } = {}) => {
    const builders: BuilderMock[] = [];
    const repo = {
      createQueryBuilder: jest.fn(() => {
        const builder = makeBuilder();
        builder.getMany.mockResolvedValue(result.entities ?? []);
        builder.getCount.mockResolvedValue(result.count ?? 0);
        builders.push(builder);
        return builder;
      }),
    };
    return { repo, builders };
  };

  const makeConversationRepo = (
    conversation: unknown = { id: 660001, ownerOrganizationId: 12 },
  ) => ({
    findOne: jest.fn().mockResolvedValue(conversation),
  });

  const messageEntity = (overrides: Record<string, unknown> = {}) => ({
    id: 770001,
    conversationId: 660001,
    messageSeq: 1,
    turnNo: 1,
    role: 'USER',
    contentText: '正文',
    createdAt: new Date('2026-09-02T09:00:00.000Z'),
    ...overrides,
  });

  it('消息固定排序 messageSeq ASC, id ASC 透传，OFFSET 分页与真实 total 并行', async () => {
    const { repo, builders } = makeMessageRepo({
      entities: [messageEntity()],
      count: 1,
    });
    const service = new AdminAiMessageQueryService(repo as never, makeConversationRepo() as never);

    const page = await service.listByConversation({
      conversationId: 660001,
      pagination: { page: 2, pageSize: 50, withTotal: true },
    });

    expect(builders).toHaveLength(2);
    expect(builders[0].where).toHaveBeenCalledWith('message.conversationId = :conversationId', {
      conversationId: 660001,
    });
    expect(builders[0].orderBy).toHaveBeenCalledWith('message.messageSeq', 'ASC');
    expect(builders[0].addOrderBy).toHaveBeenCalledWith('message.id', 'ASC');
    expect(builders[0].offset).toHaveBeenCalledWith(50);
    expect(builders[0].limit).toHaveBeenCalledWith(50);
    expect(builders[1].getCount).toHaveBeenCalled();
    expect(builders[0].innerJoin).not.toHaveBeenCalled();
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      id: 770001,
      conversationId: 660001,
      messageSeq: 1,
      turnNo: 1,
      role: 'USER',
      contentText: '正文',
    });
  });

  it('100 轮消息分页读取语义：pageSize = 100 时一次查询可覆盖满轮会话', async () => {
    const { repo, builders } = makeMessageRepo();
    const service = new AdminAiMessageQueryService(repo as never, makeConversationRepo() as never);

    await service.listByConversation({
      conversationId: 660001,
      pagination: { page: 1, pageSize: 100, withTotal: true },
    });

    expect(builders[0].offset).toHaveBeenCalledWith(0);
    expect(builders[0].limit).toHaveBeenCalledWith(100);
  });

  it('withTotal 为 false 时不执行 count 查询', async () => {
    const { repo, builders } = makeMessageRepo();
    const service = new AdminAiMessageQueryService(repo as never, makeConversationRepo() as never);

    await service.listByConversation({
      conversationId: 660001,
      pagination: { page: 1, pageSize: 50, withTotal: false },
    });

    expect(builders).toHaveLength(1);
    expect(builders[0].getCount).not.toHaveBeenCalled();
  });

  it('非法分页参数二级防御钳制', async () => {
    const { repo, builders } = makeMessageRepo();
    const service = new AdminAiMessageQueryService(repo as never, makeConversationRepo() as never);

    await service.listByConversation({
      conversationId: 660001,
      pagination: { page: -1, pageSize: 0, withTotal: true },
    });

    expect(builders[0].offset).toHaveBeenCalledWith(0);
    expect(builders[0].limit).toHaveBeenCalledWith(1);
  });

  it('列表只投影必要字段：不携带实体上未进契约的内部字段', async () => {
    const { repo } = makeMessageRepo({
      entities: [messageEntity({ metadata: { internal: true }, tokenUsage: 120 })],
    });
    const service = new AdminAiMessageQueryService(repo as never, makeConversationRepo() as never);

    const page = await service.listByConversation({
      conversationId: 660001,
      pagination: { page: 1, pageSize: 50, withTotal: true },
    });

    expect(page.items[0]).not.toHaveProperty('metadata');
    expect(page.items[0]).not.toHaveProperty('tokenUsage');
  });

  it('二级管理员读取本公司会话消息：会话查找与消息查询均带同一组织范围', async () => {
    const { repo, builders } = makeMessageRepo({ entities: [messageEntity()] });
    const conversationRepo = makeConversationRepo({ id: 660001, ownerOrganizationId: 12 });
    const service = new AdminAiMessageQueryService(repo as never, conversationRepo as never);

    await service.listByConversation({
      conversationId: 660001,
      ownerOrganizationId: 12,
      pagination: { page: 1, pageSize: 50, withTotal: true },
    });

    expect(conversationRepo.findOne).toHaveBeenCalledWith({
      where: { id: 660001, ownerOrganizationId: 12 },
      select: { id: true },
    });
    expect(builders[0].innerJoin).toHaveBeenCalledWith(
      expect.anything(),
      'conversation',
      'conversation.id = message.conversationId',
    );
    expect(builders[0].andWhere).toHaveBeenCalledWith(
      'conversation.ownerOrganizationId = :ownerOrganizationId',
      { ownerOrganizationId: 12 },
    );
    expect(builders[0].getMany).toHaveBeenCalled();
  });

  it('跨公司会话与随机不存在 ID 返回完全一致的 NOT_FOUND，且不读取消息', async () => {
    const crossCompany = makeMessageRepo();
    const crossService = new AdminAiMessageQueryService(
      crossCompany.repo as never,
      makeConversationRepo(null) as never,
    );
    const missing = makeMessageRepo();
    const missingService = new AdminAiMessageQueryService(
      missing.repo as never,
      makeConversationRepo(null) as never,
    );

    const capture = async (service: AdminAiMessageQueryService, conversationId: number) => {
      try {
        await service.listByConversation({
          conversationId,
          ownerOrganizationId: 12,
          pagination: { page: 1, pageSize: 50, withTotal: true },
        });
        return null;
      } catch (error) {
        return error as { code: string; message: string; details?: unknown };
      }
    };

    const crossError = await capture(crossService, 660001);
    const missingError = await capture(missingService, 999999999);

    expect(crossError).not.toBeNull();
    expect(missingError).toEqual(crossError);
    expect(crossError?.code).toBe('ADMIN_DOCUMENT_DATABASE_NOT_FOUND');
    expect(crossCompany.repo.createQueryBuilder).not.toHaveBeenCalled();
    expect(missing.repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('本公司存在但无消息的会话返回成功空页', async () => {
    const { repo } = makeMessageRepo();
    const service = new AdminAiMessageQueryService(
      repo as never,
      makeConversationRepo({ id: 660001, ownerOrganizationId: 12 }) as never,
    );

    const page = await service.listByConversation({
      conversationId: 660001,
      ownerOrganizationId: 12,
      pagination: { page: 1, pageSize: 50, withTotal: true },
    });

    expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 50 });
  });

  it('一级管理员不需要会话存在性预查，不存在的 ID 保持空页语义', async () => {
    const { repo, builders } = makeMessageRepo();
    const conversationRepo = makeConversationRepo(null);
    const service = new AdminAiMessageQueryService(repo as never, conversationRepo as never);

    const page = await service.listByConversation({
      conversationId: 999999999,
      pagination: { page: 1, pageSize: 50, withTotal: true },
    });

    expect(conversationRepo.findOne).not.toHaveBeenCalled();
    expect(builders[0].innerJoin).not.toHaveBeenCalled();
    expect(page).toMatchObject({ items: [], total: 0 });
  });
});
