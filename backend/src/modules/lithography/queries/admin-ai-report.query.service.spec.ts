// src/modules/lithography/queries/admin-ai-report.query.service.spec.ts

import { ADMIN_DOCUMENT_DATABASE_ERROR, DomainError } from '@core/common/errors/domain-error';
import { captureThrownError } from '../../../../test/support/account/admin-user.fixture';
import { AiConversationEntity } from '../entities/ai-conversation.entity';
import { AiReportEntity } from '../entities/ai-report.entity';
import { AdminAiReportQueryService } from './admin-ai-report.query.service';

/**
 * PR3 S4：管理员 AI 报告读侧 QueryService 单测。
 *
 * 核心口径（PR3 定向 Review M-04 裁定）：requestNo 展示与筛选以会话归属申请
 * 为权威（report → conversation → repair_request 链）；报告记录的申请与会话
 * 归属不一致时输出 requestMismatch 审计标记，不静默改写。
 */
describe('AdminAiReportQueryService', () => {
  const pagination = { page: 1, pageSize: 10, withTotal: true };

  const makeQbStub = () => {
    const qb: Record<string, jest.Mock> = {
      leftJoin: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
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
    qb.getOne = jest.fn().mockResolvedValue(null);
    qb.getCount = jest.fn().mockResolvedValue(0);
    qb.getRawMany = jest.fn().mockResolvedValue([]);
    return qb;
  };

  const makeRepos = () => ({
    reportRepo: {
      createQueryBuilder: jest.fn().mockImplementation(makeQbStub),
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
    },
    conversationRepo: {
      createQueryBuilder: jest.fn().mockImplementation(makeQbStub),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    },
    requestRepo: {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    },
  });

  const reportEntity = (overrides: Partial<AiReportEntity> = {}) => ({
    id: 550001,
    conversationId: 660001,
    requestId: 880001,
    engineerAccountId: 900002,
    reportTitle: '诊断报告',
    reportType: 'DIAGNOSIS',
    contentMd: '# 报告正文',
    createdAt: new Date('2026-09-02T10:30:00.000Z'),
    ...overrides,
  });

  const conversationEntity = (overrides: Partial<AiConversationEntity> = {}) =>
    ({
      id: 660001,
      requestId: 880001,
      ...overrides,
    }) as unknown as AiConversationEntity;

  it('列表固定排序 + OFFSET 分页；列表项不投影 contentMd 大字段', async () => {
    const repos = makeRepos();
    const listQb = makeQbStub();
    listQb.getMany.mockResolvedValue([reportEntity()]);
    repos.reportRepo.createQueryBuilder.mockImplementation(() => listQb);
    repos.conversationRepo.find.mockResolvedValue([conversationEntity()]);
    repos.requestRepo.find.mockResolvedValue([{ id: 880001, requestNo: 'RR-20260901-001' }]);
    const service = new AdminAiReportQueryService(
      repos.reportRepo as never,
      repos.conversationRepo as never,
      repos.requestRepo as never,
    );

    const page = await service.listAll({ filter: {}, pagination });

    expect(listQb.orderBy).toHaveBeenCalledWith('report.createdAt', 'DESC');
    expect(listQb.addOrderBy).toHaveBeenCalledWith('report.id', 'DESC');
    expect(listQb.offset).toHaveBeenCalledWith(0);
    expect(listQb.limit).toHaveBeenCalledWith(10);
    expect(listQb.getCount).toHaveBeenCalledTimes(1);
    expect(page.items[0]).toMatchObject({
      id: 550001,
      requestNo: 'RR-20260901-001',
      conversationId: 660001,
      reportType: 'DIAGNOSIS',
    });
    expect(page.items[0]).not.toHaveProperty('contentMd');
  });

  it('批量装配防 N+1：会话与权威申请各一次批量读取', async () => {
    const repos = makeRepos();
    const listQb = makeQbStub();
    listQb.getMany.mockResolvedValue([reportEntity(), reportEntity({ id: 550002 })]);
    repos.reportRepo.createQueryBuilder.mockImplementation(() => listQb);
    repos.conversationRepo.find.mockResolvedValue([conversationEntity()]);
    repos.requestRepo.find.mockResolvedValue([{ id: 880001, requestNo: 'RR-20260901-001' }]);
    const service = new AdminAiReportQueryService(
      repos.reportRepo as never,
      repos.conversationRepo as never,
      repos.requestRepo as never,
    );

    await service.listAll({ filter: {}, pagination });

    expect(repos.conversationRepo.find).toHaveBeenCalledTimes(1);
    expect(repos.requestRepo.find).toHaveBeenCalledTimes(1);
    const requestIn = (
      repos.requestRepo.find.mock.calls[0][0] as { where: { id: { value: unknown[] } } }
    ).where.id.value;
    expect(requestIn).toEqual([880001]);
  });

  it('M-04：报告申请与会话归属不一致时，requestNo 取会话权威申请且标记 requestMismatch', async () => {
    const repos = makeRepos();
    const listQb = makeQbStub();
    listQb.getMany.mockResolvedValue([reportEntity({ requestId: 880002 })]);
    repos.reportRepo.createQueryBuilder.mockImplementation(() => listQb);
    repos.conversationRepo.find.mockResolvedValue([conversationEntity({ requestId: 880001 })]);
    repos.requestRepo.find.mockResolvedValue([{ id: 880001, requestNo: 'RR-20260901-001' }]);
    const service = new AdminAiReportQueryService(
      repos.reportRepo as never,
      repos.conversationRepo as never,
      repos.requestRepo as never,
    );

    const page = await service.listAll({ filter: {}, pagination });

    expect(page.items[0].requestId).toBe(880002);
    expect(page.items[0].requestNo).toBe('RR-20260901-001');
    expect(page.items[0].requestMismatch).toBe(true);
  });

  it('归属一致时 requestMismatch 为 false；会话缺失回落报告自身申请且不误标', async () => {
    const repos = makeRepos();
    const service = new AdminAiReportQueryService(
      repos.reportRepo as never,
      repos.conversationRepo as never,
      repos.requestRepo as never,
    );
    // 一致场景
    const listQb = makeQbStub();
    listQb.getMany.mockResolvedValue([reportEntity()]);
    repos.reportRepo.createQueryBuilder.mockImplementation(() => listQb);
    repos.conversationRepo.find.mockResolvedValue([conversationEntity({ requestId: 880001 })]);
    repos.requestRepo.find.mockResolvedValue([{ id: 880001, requestNo: 'RR-20260901-001' }]);
    const consistent = await service.listAll({ filter: {}, pagination });
    expect(consistent.items[0].requestMismatch).toBe(false);

    // 会话缺失场景
    const missingQb = makeQbStub();
    missingQb.getMany.mockResolvedValue([reportEntity()]);
    repos.reportRepo.createQueryBuilder.mockImplementation(() => missingQb);
    repos.conversationRepo.find.mockResolvedValue([]);
    repos.requestRepo.find.mockResolvedValue([]);
    const fallback = await service.listAll({ filter: {}, pagination });
    expect(fallback.items[0].requestMismatch).toBe(false);
    expect(fallback.items[0].requestNo).toBe('');
  });

  it('详情：不存在统一 NOT_FOUND', async () => {
    const repos = makeRepos();
    const service = new AdminAiReportQueryService(
      repos.reportRepo as never,
      repos.conversationRepo as never,
      repos.requestRepo as never,
    );

    const error = await captureThrownError(service.findDetailById(550001));
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND);
  });

  it('详情返回正文；mismatch 审计标记与权威 requestNo 同口径', async () => {
    const repos = makeRepos();
    repos.reportRepo.findOne.mockResolvedValue(reportEntity({ requestId: 880002 }));
    repos.conversationRepo.findOne.mockResolvedValue(conversationEntity({ requestId: 880001 }));
    repos.requestRepo.findOne.mockResolvedValueOnce({
      id: 880001,
      requestNo: 'RR-20260901-001',
    });
    const service = new AdminAiReportQueryService(
      repos.reportRepo as never,
      repos.conversationRepo as never,
      repos.requestRepo as never,
    );

    const detail = await service.findDetailById(550001);

    expect(detail).toMatchObject({
      id: 550001,
      requestId: 880002,
      requestNo: 'RR-20260901-001',
      requestMismatch: true,
      conversationId: 660001,
      contentMd: '# 报告正文',
    });
  });

  it('详情：会话缺失时回落报告自身申请，requestMismatch 不误标', async () => {
    const repos = makeRepos();
    repos.reportRepo.findOne.mockResolvedValue(reportEntity());
    repos.conversationRepo.findOne.mockResolvedValue(null);
    repos.requestRepo.findOne.mockResolvedValue({
      id: 880001,
      requestNo: 'RR-20260901-001',
    });
    const service = new AdminAiReportQueryService(
      repos.reportRepo as never,
      repos.conversationRepo as never,
      repos.requestRepo as never,
    );

    const detail = await service.findDetailById(550001);

    expect(detail.requestMismatch).toBe(false);
    expect(detail.requestNo).toBe('RR-20260901-001');
  });

  it('二级管理员列表按会话归属组织过滤，列表与总数同口径', async () => {
    const repos = makeRepos();
    const listQb = makeQbStub();
    repos.reportRepo.createQueryBuilder.mockImplementation(() => listQb);
    const service = new AdminAiReportQueryService(
      repos.reportRepo as never,
      repos.conversationRepo as never,
      repos.requestRepo as never,
    );

    await service.listAll({ filter: { ownerOrganizationId: 12 }, pagination });

    expect(listQb.andWhere).toHaveBeenCalledWith(
      'conversation.ownerOrganizationId = :ownerOrganizationId',
      { ownerOrganizationId: 12 },
    );
    expect(listQb.getCount).toHaveBeenCalledTimes(1);
  });

  it('二级管理员详情按会话归属组织读取；跨公司详情统一 NOT_FOUND', async () => {
    const repos = makeRepos();
    const scopedQb = makeQbStub();
    scopedQb.getOne.mockResolvedValue(reportEntity());
    repos.reportRepo.createQueryBuilder.mockImplementation(() => scopedQb);
    repos.conversationRepo.findOne.mockResolvedValue(conversationEntity());
    repos.requestRepo.findOne.mockResolvedValue({ id: 880001, requestNo: 'RR-20260901-001' });
    const service = new AdminAiReportQueryService(
      repos.reportRepo as never,
      repos.conversationRepo as never,
      repos.requestRepo as never,
    );

    const detail = await service.findDetailById(550001, 12);
    expect(detail).toMatchObject({ id: 550001, conversationId: 660001 });
    expect(scopedQb.innerJoin).toHaveBeenCalled();
    expect(scopedQb.andWhere).toHaveBeenCalledWith(
      'conversation.ownerOrganizationId = :ownerOrganizationId',
      { ownerOrganizationId: 12 },
    );

    const crossQb = makeQbStub();
    crossQb.getOne.mockResolvedValue(null);
    repos.reportRepo.createQueryBuilder.mockImplementation(() => crossQb);
    const error = await captureThrownError(service.findDetailById(550001, 12));
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND);
    expect(repos.reportRepo.findOne).not.toHaveBeenCalled();
  });

  it('统计总数为全量 count', async () => {
    const repos = makeRepos();
    repos.reportRepo.count.mockResolvedValue(9);
    const service = new AdminAiReportQueryService(
      repos.reportRepo as never,
      repos.conversationRepo as never,
      repos.requestRepo as never,
    );

    await expect(service.countAll()).resolves.toBe(9);
    expect(repos.reportRepo.count).toHaveBeenCalledWith();
  });

  it('engineerAccountIds 空集合短路返回空页，不发起任何查询', async () => {
    const repos = makeRepos();
    const service = new AdminAiReportQueryService(
      repos.reportRepo as never,
      repos.conversationRepo as never,
      repos.requestRepo as never,
    );

    const page = await service.listAll({ filter: { engineerAccountIds: [] }, pagination });

    expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 10 });
    expect(repos.reportRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});
