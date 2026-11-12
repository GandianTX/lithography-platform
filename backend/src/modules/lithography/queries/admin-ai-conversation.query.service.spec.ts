// src/modules/lithography/queries/admin-ai-conversation.query.service.spec.ts

import { AiConversationStatus } from '@app-types/models/ai-conversation.types';

import { AiConversationEntity } from '../entities/ai-conversation.entity';
import { AdminAiConversationQueryService } from './admin-ai-conversation.query.service';

/**
 * PR3 S4：管理员 AI 会话读侧 QueryService 单测。
 *
 * QueryService 以 QueryBuilder 组织 SQL：筛选全部在 SQL 侧执行保证分页正确性；
 * 消息数 / 报告数经 GROUP BY 聚合而非加载明细行；关联申请编号批量读取防 N+1。
 */
describe('AdminAiConversationQueryService', () => {
  const pagination = { page: 1, pageSize: 10, withTotal: true };

  /** 链式 QueryBuilder 替身：中间方法 returnThis，终端方法可按用例注入返回值 */
  const makeQbStub = () => {
    const qb: Record<string, jest.Mock> = {
      leftJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
    };
    qb.getMany = jest.fn().mockResolvedValue([]);
    qb.getCount = jest.fn().mockResolvedValue(0);
    qb.getRawMany = jest.fn().mockResolvedValue([]);
    return qb;
  };

  const makeRepos = () => ({
    conversationRepo: {
      createQueryBuilder: jest.fn().mockImplementation(makeQbStub),
      count: jest.fn().mockResolvedValue(0),
    },
    messageRepo: { createQueryBuilder: jest.fn().mockImplementation(makeQbStub) },
    reportRepo: { createQueryBuilder: jest.fn().mockImplementation(makeQbStub) },
    requestRepo: { find: jest.fn().mockResolvedValue([]) },
  });

  const conversationEntity = (overrides: Partial<AiConversationEntity> = {}) => ({
    id: 660001,
    requestId: 880001,
    engineerAccountId: 900002,
    status: AiConversationStatus.COMPLETED,
    aiFeedback: null,
    createdAt: new Date('2026-09-02T09:00:00.000Z'),
    completedAt: new Date('2026-09-02T10:00:00.000Z'),
    ...overrides,
  });

  it('列表固定排序 + OFFSET 分页；withTotal 时走同条件 count（含关联）', async () => {
    const repos = makeRepos();
    const service = new AdminAiConversationQueryService(
      repos.conversationRepo as never,
      repos.messageRepo as never,
      repos.reportRepo as never,
      repos.requestRepo as never,
    );

    await service.listAll({ filter: {}, pagination });

    const listQb = repos.conversationRepo.createQueryBuilder.mock.results[0].value;
    expect(listQb.orderBy).toHaveBeenCalledWith('conversation.createdAt', 'DESC');
    expect(listQb.addOrderBy).toHaveBeenCalledWith('conversation.id', 'DESC');
    expect(listQb.offset).toHaveBeenCalledWith(0);
    expect(listQb.limit).toHaveBeenCalledWith(10);
    expect(listQb.leftJoin).toHaveBeenCalledWith(
      expect.anything(),
      'request',
      'request.id = conversation.requestId',
    );
    // count 与列表各建一个同条件 QueryBuilder
    const countQb = repos.conversationRepo.createQueryBuilder.mock.results[1].value;
    expect(countQb.getCount).toHaveBeenCalledTimes(1);
    expect(countQb.leftJoin).toHaveBeenCalledWith(
      expect.anything(),
      'request',
      'request.id = conversation.requestId',
    );
  });

  it('engineerAccountIds 空集合短路返回空页，不发起任何查询', async () => {
    const repos = makeRepos();
    const service = new AdminAiConversationQueryService(
      repos.conversationRepo as never,
      repos.messageRepo as never,
      repos.reportRepo as never,
      repos.requestRepo as never,
    );

    const page = await service.listAll({
      filter: { engineerAccountIds: [] },
      pagination,
    });

    expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 10 });
    expect(repos.conversationRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('筛选收敛为 SQL 侧条件：requestNo LIKE / status 等值 / engineerAccountIds IN / 时间范围', async () => {
    const repos = makeRepos();
    const service = new AdminAiConversationQueryService(
      repos.conversationRepo as never,
      repos.messageRepo as never,
      repos.reportRepo as never,
      repos.requestRepo as never,
    );

    await service.listAll({
      filter: {
        requestNo: '100%_x',
        engineerAccountIds: [900002],
        status: AiConversationStatus.COMPLETED,
        createdAtFrom: new Date('2026-09-01T00:00:00.000Z'),
      },
      pagination,
    });

    const listQb = repos.conversationRepo.createQueryBuilder.mock.results[0].value;
    const andWhereCalls = listQb.andWhere.mock.calls as unknown as Array<
      [string | object, Record<string, unknown> | undefined]
    >;
    const params = andWhereCalls
      .map((call) => call[1])
      .filter(Boolean)
      .reduce<Record<string, unknown>>((acc, cur) => ({ ...acc, ...cur }), {});
    // requestNo LIKE 通配符转义注入
    expect(params.requestNoPattern).toBe('%100\\%\\_x%');
    expect(params.engineerAccountIds).toEqual([900002]);
    expect(params.status).toBe('COMPLETED');
    // 4 类筛选各产生一条 andWhere；时间范围以 Brackets 闭包组织（内含 from/to 参数）
    expect(andWhereCalls).toHaveLength(4);
    expect(andWhereCalls.filter((call) => typeof call[0] === 'object')).toHaveLength(1);
  });

  it('批量装配防 N+1：申请编号一次批量读取；消息数/报告数 GROUP BY 聚合（不加载明细）', async () => {
    const repos = makeRepos();
    const listQb = makeQbStub();
    listQb.getMany.mockResolvedValue([
      conversationEntity(),
      conversationEntity({ id: 660002, requestId: 880001 }),
    ]);
    repos.conversationRepo.createQueryBuilder.mockImplementation(() => listQb);
    const messageQb = makeQbStub();
    messageQb.getRawMany.mockResolvedValue([
      { conversationId: 660001, count: '12' },
      { conversationId: 660002, count: '3' },
    ]);
    repos.messageRepo.createQueryBuilder.mockImplementation(() => messageQb);
    const reportQb = makeQbStub();
    reportQb.getRawMany.mockResolvedValue([{ conversationId: 660001, count: 1 }]);
    repos.reportRepo.createQueryBuilder.mockImplementation(() => reportQb);
    repos.requestRepo.find.mockResolvedValue([{ id: 880001, requestNo: 'RR-20260901-001' }]);
    const service = new AdminAiConversationQueryService(
      repos.conversationRepo as never,
      repos.messageRepo as never,
      repos.reportRepo as never,
      repos.requestRepo as never,
    );

    const page = await service.listAll({ filter: {}, pagination });

    expect(repos.requestRepo.find).toHaveBeenCalledTimes(1);
    const inValue = (
      repos.requestRepo.find.mock.calls[0][0] as { where: { id: { value: unknown } } }
    ).where.id.value as unknown[];
    expect(inValue).toEqual([880001]);
    // 两条会话共享同一次消息/报告聚合查询
    expect(repos.messageRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(repos.reportRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(page.items).toMatchObject([
      {
        id: 660001,
        requestNo: 'RR-20260901-001',
        messageCount: 12,
        reportCount: 1,
        engineerAccountId: 900002,
      },
      { id: 660002, messageCount: 3, reportCount: 0 },
    ]);
  });

  it('关联申请缺失时 requestNo 回落空串，不阻塞列表可读', async () => {
    const repos = makeRepos();
    const listQb = makeQbStub();
    listQb.getMany.mockResolvedValue([conversationEntity()]);
    repos.conversationRepo.createQueryBuilder.mockImplementation(() => listQb);
    const service = new AdminAiConversationQueryService(
      repos.conversationRepo as never,
      repos.messageRepo as never,
      repos.reportRepo as never,
      repos.requestRepo as never,
    );

    const page = await service.listAll({ filter: {}, pagination });

    expect(page.items[0].requestNo).toBe('');
  });

  it('统计总数为全量 count（AI 会话无软删除概念）', async () => {
    const repos = makeRepos();
    repos.conversationRepo.count.mockResolvedValue(7);
    const service = new AdminAiConversationQueryService(
      repos.conversationRepo as never,
      repos.messageRepo as never,
      repos.reportRepo as never,
      repos.requestRepo as never,
    );

    await expect(service.countAll()).resolves.toBe(7);
    expect(repos.conversationRepo.count).toHaveBeenCalledWith();
  });

  it('二级管理员列表按归属组织过滤，列表与总数同口径', async () => {
    const repos = makeRepos();
    const service = new AdminAiConversationQueryService(
      repos.conversationRepo as never,
      repos.messageRepo as never,
      repos.reportRepo as never,
      repos.requestRepo as never,
    );

    await service.listAll({ filter: { ownerOrganizationId: 12 }, pagination });

    const listQb = repos.conversationRepo.createQueryBuilder.mock.results[0].value;
    const countQb = repos.conversationRepo.createQueryBuilder.mock.results[1].value;
    expect(listQb.andWhere).toHaveBeenCalledWith(
      'conversation.ownerOrganizationId = :ownerOrganizationId',
      { ownerOrganizationId: 12 },
    );
    expect(countQb.andWhere).toHaveBeenCalledWith(
      'conversation.ownerOrganizationId = :ownerOrganizationId',
      { ownerOrganizationId: 12 },
    );
  });

  it('空列表不触发申请与计数装配', async () => {
    const repos = makeRepos();
    const service = new AdminAiConversationQueryService(
      repos.conversationRepo as never,
      repos.messageRepo as never,
      repos.reportRepo as never,
      repos.requestRepo as never,
    );

    await service.listAll({ filter: {}, pagination });

    expect(repos.requestRepo.find).not.toHaveBeenCalled();
    expect(repos.messageRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(repos.reportRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});
