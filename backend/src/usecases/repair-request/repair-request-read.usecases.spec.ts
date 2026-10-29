/// <reference types="jest" />
import { RepairRequestAcceptanceViewStatus } from '@app-types/models/repair-request.types';
import { REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { RepairRequestQueryService } from '@src/modules/lithography/queries/repair-request.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { GetEngineerRepairRequestDetailUsecase } from './get-engineer-repair-request-detail.usecase';
import { GetMyRepairRequestDetailUsecase } from './get-my-repair-request-detail.usecase';
import { ListEngineerRepairRequestsUsecase } from './list-engineer-repair-requests.usecase';
import { ListMyRepairRequestsUsecase } from './list-my-repair-requests.usecase';

const makeQueryService = () => ({
  listByCustomer: jest.fn().mockResolvedValue({ items: [], page: 1, pageSize: 10 }),
  listByEngineer: jest.fn().mockResolvedValue({
    items: [
      {
        id: 1,
        requestNo: '920_001',
        equipmentModel: { id: 5, modelCode: 'M', modelName: 'N' },
        errorCode: 'E-01',
        createdAt: new Date('2026-08-30T00:00:00.000Z'),
        isAccepted: true,
        acceptedAt: new Date('2026-08-30T02:00:00.000Z'),
        latestResolutionStatus: null,
        customerAccountId: 10,
        acceptedByEngineerAccountId: 20,
      },
    ],
    page: 1,
    pageSize: 10,
  }),
  findDetail: jest.fn().mockResolvedValue({ id: 1 }),
});

const session = { accountId: 10, roles: ['CUSTOMER'] };

/** 可信组织上下文模拟：默认无组织归属（null），可按需返回单一有效成员事实 */
const makeOrganizationContext = (organizationId: number | null = null) => ({
  tryResolveForAccount: jest.fn().mockResolvedValue(
    organizationId === null
      ? null
      : {
          membershipId: 1,
          organizationId,
          organizationCode: 'CLIENT_DEFAULT',
          organizationName: '甲方默认组织',
          organizationKind: 'CLIENT',
          memberRole: 'ENGINEER',
        },
  ),
});

describe('ListMyRepairRequestsUsecase', () => {
  it('OFFSET 分页透传至读侧查询服务，withTotal 缺省为 false', async () => {
    const queryService = makeQueryService();
    const usecase = new ListMyRepairRequestsUsecase(
      queryService as unknown as RepairRequestQueryService,
    );

    await usecase.execute({
      session,
      pagination: { mode: 'OFFSET', page: 2, pageSize: 5 },
    });

    expect(queryService.listByCustomer).toHaveBeenCalledWith({
      customerAccountId: 10,
      pagination: { page: 2, pageSize: 5, withTotal: false },
    });
  });

  it('CURSOR 分页第一版拒绝（参数错误码）', async () => {
    const queryService = makeQueryService();
    const usecase = new ListMyRepairRequestsUsecase(
      queryService as unknown as RepairRequestQueryService,
    );

    await expect(
      usecase.execute({
        session,
        pagination: { mode: 'CURSOR', limit: 5 },
      }),
    ).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.INVALID_PARAMS,
      details: { mode: 'CURSOR' },
    });
    expect(queryService.listByCustomer).not.toHaveBeenCalled();
  });

  it('pageSize 超上限时在用例层钳制为 100（传输无关策略，不依赖 GraphQL 边界校验）', async () => {
    const queryService = makeQueryService();
    const usecase = new ListMyRepairRequestsUsecase(
      queryService as unknown as RepairRequestQueryService,
    );

    await usecase.execute({
      session,
      pagination: { mode: 'OFFSET', page: 1, pageSize: 500 },
    });

    expect(queryService.listByCustomer).toHaveBeenCalledWith({
      customerAccountId: 10,
      pagination: { page: 1, pageSize: 100, withTotal: false },
    });
  });
});

describe('ListEngineerRepairRequestsUsecase', () => {
  const engineerSession = { accountId: 20, roles: ['ENGINEER'] };

  const makeAccountQueryService = (
    options: {
      nicknameAccountIds?: number[];
      profiles?: Map<number, { nickname: string; companyName: string | null }>;
    } = {},
  ) => ({
    findAccountIdsByNicknameKeyword: jest.fn().mockResolvedValue(options.nicknameAccountIds ?? []),
    findAccountDisplayProfilesByAccountIds: jest
      .fn()
      .mockResolvedValue(options.profiles ?? new Map()),
  });

  const makeUsecase = (
    queryService = makeQueryService(),
    accountQueryService = makeAccountQueryService(),
    organizationContextQueryService = makeOrganizationContext(),
  ) =>
    new ListEngineerRepairRequestsUsecase(
      queryService as unknown as RepairRequestQueryService,
      accountQueryService as unknown as AccountQueryService,
      organizationContextQueryService as unknown as TrustedOrganizationContextQueryService,
    );

  it('合法范围（ALL / AVAILABLE / MINE / TAKEN_BY_OTHER）透传至读侧查询服务', async () => {
    for (const scope of ['ALL', 'AVAILABLE', 'MINE', 'TAKEN_BY_OTHER']) {
      const queryService = makeQueryService();
      const usecase = makeUsecase(queryService);

      await usecase.execute({
        session: engineerSession,
        scope,
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true },
      });

      expect(queryService.listByEngineer).toHaveBeenCalledWith({
        engineerAccountId: 20,
        scope,
        filter: { equipmentModelId: undefined, customerAccountIds: undefined },
        pagination: { page: 1, pageSize: 10, withTotal: true },
        viewerOrganizationId: null,
      });
    }
  });

  it('非法范围字符串拒绝（adapter 层不导入枚举，由用例校验映射）', async () => {
    const queryService = makeQueryService();
    const usecase = makeUsecase(queryService);

    await expect(
      usecase.execute({
        session: engineerSession,
        scope: 'BOGUS',
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
      }),
    ).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.INVALID_PARAMS,
      details: { scope: 'BOGUS' },
    });
    expect(queryService.listByEngineer).not.toHaveBeenCalled();
  });

  it('CURSOR 分页第一版拒绝', async () => {
    const queryService = makeQueryService();
    const usecase = makeUsecase(queryService);

    await expect(
      usecase.execute({
        session: engineerSession,
        scope: 'AVAILABLE',
        pagination: { mode: 'CURSOR', limit: 5 },
      }),
    ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.INVALID_PARAMS });
  });

  it('pageSize 超上限时在用例层钳制为 100', async () => {
    const queryService = makeQueryService();
    const usecase = makeUsecase(queryService);

    await usecase.execute({
      session: engineerSession,
      scope: 'AVAILABLE',
      pagination: { mode: 'OFFSET', page: 1, pageSize: 999 },
    });

    expect(queryService.listByEngineer).toHaveBeenCalledWith(
      expect.objectContaining({ pagination: { page: 1, pageSize: 100, withTotal: false } }),
    );
  });

  it('客户昵称关键词先经账号域解析为账号 ID，再进入读侧筛选（分页计数前完成筛选）', async () => {
    const queryService = makeQueryService();
    const accountQueryService = makeAccountQueryService({ nicknameAccountIds: [10, 11] });
    const usecase = makeUsecase(queryService, accountQueryService);

    await usecase.execute({
      session: engineerSession,
      scope: 'ALL',
      filter: { customerNickname: '华东' },
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true },
    });

    expect(accountQueryService.findAccountIdsByNicknameKeyword).toHaveBeenCalledWith('华东');
    expect(queryService.listByEngineer).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { equipmentModelId: undefined, customerAccountIds: [10, 11] },
      }),
    );
  });

  it('昵称关键词无匹配账号时直接空页返回，不触发列表查询（total=0）', async () => {
    const queryService = makeQueryService();
    const accountQueryService = makeAccountQueryService({ nicknameAccountIds: [] });
    const usecase = makeUsecase(queryService, accountQueryService);

    const result = await usecase.execute({
      session: engineerSession,
      scope: 'ALL',
      filter: { customerNickname: '不存在' },
      pagination: { mode: 'OFFSET', page: 2, pageSize: 5, withTotal: true },
    });

    expect(result).toEqual({ items: [], total: 0, page: 2, pageSize: 5 });
    expect(queryService.listByEngineer).not.toHaveBeenCalled();
  });

  it('昵称关键词空白归一为未筛选：不调用账号域，也不进入读侧筛选', async () => {
    const queryService = makeQueryService();
    const accountQueryService = makeAccountQueryService();
    const usecase = makeUsecase(queryService, accountQueryService);

    await usecase.execute({
      session: engineerSession,
      scope: 'ALL',
      filter: { customerNickname: '   ' },
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
    });

    expect(accountQueryService.findAccountIdsByNicknameKeyword).not.toHaveBeenCalled();
    expect(queryService.listByEngineer).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { equipmentModelId: undefined, customerAccountIds: undefined },
      }),
    );
  });

  it('昵称关键词超长拒绝（不静默截断改写搜索意图）', async () => {
    const usecase = makeUsecase();

    await expect(
      usecase.execute({
        session: engineerSession,
        scope: 'ALL',
        filter: { customerNickname: '长'.repeat(101) },
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
      }),
    ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.INVALID_PARAMS });
  });

  it('设备型号筛选必须为正整数，非法值拒绝', async () => {
    const usecase = makeUsecase();

    await expect(
      usecase.execute({
        session: engineerSession,
        scope: 'ALL',
        filter: { equipmentModelId: 0 },
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
      }),
    ).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.INVALID_PARAMS,
      details: { equipmentModelId: 0 },
    });
  });

  it('列表项富集客户/接单工程师展示资料并计算当前会话视角，账号 ID 不进入对外视图', async () => {
    const queryService = makeQueryService();
    const profiles = new Map([
      [10, { nickname: '华东客户', companyName: '华东光电子' }],
      [20, { nickname: '陈工', companyName: null }],
    ]);
    const accountQueryService = makeAccountQueryService({ profiles });
    const usecase = makeUsecase(queryService, accountQueryService);

    const result = await usecase.execute({
      session: engineerSession,
      scope: 'MINE',
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
    });

    // 一次批量资料查询（客户 + 接单工程师合并），无 N+1
    expect(accountQueryService.findAccountDisplayProfilesByAccountIds).toHaveBeenCalledTimes(1);
    expect(accountQueryService.findAccountDisplayProfilesByAccountIds).toHaveBeenCalledWith([
      10, 20,
    ]);
    expect(result.items[0]).toMatchObject({
      customerNickname: '华东客户',
      customerCompanyName: '华东光电子',
      acceptanceViewStatus: RepairRequestAcceptanceViewStatus.MINE,
      acceptedEngineerNickname: '陈工',
    });
    expect(result.items[0]).not.toHaveProperty('customerAccountId');
    expect(result.items[0]).not.toHaveProperty('acceptedByEngineerAccountId');
  });

  it('视角状态按会话账号判定：他人接单为 TAKEN_BY_OTHER，未接单为 AVAILABLE', async () => {
    const queryService = makeQueryService();
    queryService.listByEngineer.mockResolvedValue({
      items: [
        {
          id: 2,
          requestNo: '920_002',
          equipmentModel: { id: 5, modelCode: 'M', modelName: 'N' },
          errorCode: 'E-02',
          createdAt: new Date(),
          isAccepted: true,
          acceptedAt: new Date(),
          latestResolutionStatus: null,
          customerAccountId: 10,
          acceptedByEngineerAccountId: 21,
        },
        {
          id: 3,
          requestNo: '920_003',
          equipmentModel: { id: 5, modelCode: 'M', modelName: 'N' },
          errorCode: 'E-03',
          createdAt: new Date(),
          isAccepted: false,
          acceptedAt: null,
          latestResolutionStatus: null,
          customerAccountId: 11,
          acceptedByEngineerAccountId: null,
        },
      ],
      page: 1,
      pageSize: 10,
    });
    const usecase = makeUsecase(queryService);

    const result = await usecase.execute({
      session: engineerSession,
      scope: 'ALL',
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
    });

    expect(result.items[0].acceptanceViewStatus).toBe(
      RepairRequestAcceptanceViewStatus.TAKEN_BY_OTHER,
    );
    expect(result.items[0].acceptedEngineerNickname).toBeNull();
    expect(result.items[1].acceptanceViewStatus).toBe(RepairRequestAcceptanceViewStatus.AVAILABLE);
  });

  it('昵称/资料缺失时回落「客户」，未接单时接单工程师昵称为空', async () => {
    const queryService = makeQueryService();
    queryService.listByEngineer.mockResolvedValue({
      items: [
        {
          id: 4,
          requestNo: '920_004',
          equipmentModel: { id: 5, modelCode: 'M', modelName: 'N' },
          errorCode: 'E-04',
          createdAt: new Date(),
          isAccepted: false,
          acceptedAt: null,
          latestResolutionStatus: null,
          customerAccountId: 40,
          acceptedByEngineerAccountId: null,
        },
      ],
      page: 1,
      pageSize: 10,
    });
    const usecase = makeUsecase(queryService);

    const result = await usecase.execute({
      session: engineerSession,
      scope: 'ALL',
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
    });

    expect(result.items[0]).toMatchObject({
      customerNickname: '客户',
      customerCompanyName: null,
      acceptedEngineerNickname: null,
    });
  });
});

describe('详情用例（客户 / 工程师入口）', () => {
  const detailQueryResult = {
    id: 3,
    requestNo: '920_003',
    equipmentModel: { id: 5, modelCode: 'M', modelName: 'N' },
    errorCode: 'E-01',
    faultDescription: '故障',
    contentMd: '# md',
    createdAt: new Date(),
    isAccepted: true,
    acceptedAt: new Date(),
    latestResolutionStatus: 'RESOLVED',
    responses: [
      {
        id: 7,
        engineerAccountId: 20,
        resolutionStatus: 'PENDING',
        responseText: '已收到',
        createdAt: new Date(),
      },
    ],
    customerAccountId: 10,
    acceptedByEngineerAccountId: 20,
  };

  const makeDetailQueryService = () => ({
    findDetail: jest.fn().mockResolvedValue(detailQueryResult),
  });

  const makeAccountQueryService = (
    options: {
      nicknames?: Map<number, string>;
      profiles?: Map<number, { nickname: string; companyName: string | null }>;
    } = {},
  ) => ({
    findNicknamesByAccountIds: jest.fn().mockResolvedValue(options.nicknames ?? new Map()),
    findAccountDisplayProfilesByAccountIds: jest
      .fn()
      .mockResolvedValue(options.profiles ?? new Map()),
  });

  it('客户入口以 scope=CUSTOMER 读取，并把工程师账号 ID 富集为当前昵称', async () => {
    const queryService = makeDetailQueryService();
    const accountQueryService = makeAccountQueryService({ nicknames: new Map([[20, '陈工']]) });
    const usecase = new GetMyRepairRequestDetailUsecase(
      queryService as unknown as RepairRequestQueryService,
      accountQueryService as unknown as AccountQueryService,
    );

    const result = await usecase.execute({ requestId: 3, session });

    expect(queryService.findDetail).toHaveBeenCalledWith({
      requestId: 3,
      session,
      scope: 'CUSTOMER',
    });
    expect(accountQueryService.findNicknamesByAccountIds).toHaveBeenCalledWith([20]);
    expect(result.responses[0]).toMatchObject({ id: 7, engineerNickname: '陈工' });
    // 契约防泄漏：对外视图不含工程师账号 ID（负责人裁定 3）
    expect(result.responses[0]).not.toHaveProperty('engineerAccountId');
    // 客户入口不做客户/接单工程师资料富集
    expect(result).not.toHaveProperty('acceptanceViewStatus');
    expect(result).not.toHaveProperty('customerNickname');
  });

  it('工程师入口以 scope=ENGINEER 读取并富集客户/接单工程师资料与视角状态', async () => {
    const queryService = makeDetailQueryService();
    const profiles = new Map([
      [10, { nickname: '华东客户', companyName: '华东光电子' }],
      [20, { nickname: '陈工', companyName: null }],
    ]);
    const accountQueryService = makeAccountQueryService({
      nicknames: new Map([[20, '陈工']]),
      profiles,
    });
    const usecase = new GetEngineerRepairRequestDetailUsecase(
      queryService as unknown as RepairRequestQueryService,
      accountQueryService as unknown as AccountQueryService,
      makeOrganizationContext() as unknown as TrustedOrganizationContextQueryService,
    );

    const result = await usecase.execute({
      requestId: 3,
      session: { accountId: 20, roles: ['ENGINEER'] },
    });

    expect(queryService.findDetail).toHaveBeenCalledWith({
      requestId: 3,
      session: { accountId: 20, roles: ['ENGINEER'] },
      scope: 'ENGINEER',
      viewerOrganizationId: null,
    });
    // 一次批量资料查询（客户 + 接单工程师合并），无 N+1
    expect(accountQueryService.findAccountDisplayProfilesByAccountIds).toHaveBeenCalledTimes(1);
    expect(accountQueryService.findAccountDisplayProfilesByAccountIds).toHaveBeenCalledWith([
      10, 20,
    ]);
    expect(result).toMatchObject({
      customerNickname: '华东客户',
      customerCompanyName: '华东光电子',
      acceptanceViewStatus: RepairRequestAcceptanceViewStatus.MINE,
      acceptedEngineerNickname: '陈工',
    });
    // 契约防泄漏：归属类账号 ID 不进入对外视图
    expect(result).not.toHaveProperty('customerAccountId');
    expect(result).not.toHaveProperty('acceptedByEngineerAccountId');
  });

  it('工程师入口视角按会话账号判定：他人接单为 TAKEN_BY_OTHER', async () => {
    const queryService = makeDetailQueryService();
    const accountQueryService = makeAccountQueryService({
      profiles: new Map([[20, { nickname: '陈工', companyName: null }]]),
    });
    const usecase = new GetEngineerRepairRequestDetailUsecase(
      queryService as unknown as RepairRequestQueryService,
      accountQueryService as unknown as AccountQueryService,
      makeOrganizationContext() as unknown as TrustedOrganizationContextQueryService,
    );

    const result = await usecase.execute({
      requestId: 3,
      session: { accountId: 99, roles: ['ENGINEER'] },
    });

    expect(result.acceptanceViewStatus).toBe(RepairRequestAcceptanceViewStatus.TAKEN_BY_OTHER);
    expect(result.acceptedEngineerNickname).toBe('陈工');
  });

  it('昵称缺失时回落「工程师」（负责人裁定 3）', async () => {
    const queryService = makeDetailQueryService();
    const accountQueryService = makeAccountQueryService();
    const usecase = new GetMyRepairRequestDetailUsecase(
      queryService as unknown as RepairRequestQueryService,
      accountQueryService as unknown as AccountQueryService,
    );

    const result = await usecase.execute({ requestId: 3, session });

    expect(result.responses[0].engineerNickname).toBe('工程师');
  });

  it('无回复时不调用昵称查询，回复为空数组', async () => {
    const queryService = {
      findDetail: jest.fn().mockResolvedValue({ ...detailQueryResult, responses: [] }),
    };
    const accountQueryService = makeAccountQueryService();
    const usecase = new GetMyRepairRequestDetailUsecase(
      queryService as unknown as RepairRequestQueryService,
      accountQueryService as unknown as AccountQueryService,
    );

    const result = await usecase.execute({ requestId: 3, session });

    expect(result.responses).toEqual([]);
    expect(accountQueryService.findNicknamesByAccountIds).toHaveBeenCalledWith([]);
  });
});
