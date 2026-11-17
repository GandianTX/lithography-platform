// src/modules/lithography/queries/admin-repair-request.query.service.spec.ts

import { Between, IsNull } from 'typeorm';

import { ADMIN_DOCUMENT_DATABASE_ERROR, DomainError } from '@core/common/errors/domain-error';
import { captureThrownError } from '../../../../test/support/account/admin-user.fixture';
import { EquipmentModelEntity } from '../entities/equipment-model.entity';
import { RepairRequestEntity } from '../entities/repair-request.entity';
import { AdminRepairRequestQueryService } from './admin-repair-request.query.service';
import { RepairProcessEntryQueryService } from './repair-process-entry.query.service';

/**
 * PR3 S4：管理员维修申请读侧 QueryService 单测。
 *
 * 覆盖计划表 S4.1 的读模型语义：软删除默认过滤、真实 total、固定排序
 * （排序白名单由契约冻结，不采纳客户端排序）、时间范围边界、空集合短路、
 * 摘要的删除状态防探测口径与批量装配防 N+1。
 */
describe('AdminRepairRequestQueryService', () => {
  const pagination = { page: 1, pageSize: 10, withTotal: true };

  const makeIntakeRepo = () => ({ findOne: jest.fn().mockResolvedValue(null) });
  const makeRequestRepo = (intakeRepo = makeIntakeRepo()) => ({
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    findOne: jest.fn().mockResolvedValue(null),
    manager: { getRepository: jest.fn(() => intakeRepo) },
  });
  const makeResponseRepo = () => ({ find: jest.fn().mockResolvedValue([]) });
  const makeModelRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
  });
  const makeRevisionRepo = () => ({ find: jest.fn().mockResolvedValue([]) });
  const makeProcessEntryQuery = () => ({
    listByRequest: jest.fn().mockResolvedValue([]),
    listByRequestTextOnly: jest.fn().mockResolvedValue([]),
  });

  const requestEntity = (overrides: Partial<RepairRequestEntity> = {}) =>
    ({
      id: 880001,
      requestNo: 'RR-20260901-001',
      customerAccountId: 900001,
      equipmentModelId: 930001,
      errorCode: 'E-001',
      faultDescription: '描述',
      contentMd: '# 正文',
      isAccepted: false,
      acceptedAt: null,
      acceptedByEngineerAccountId: null,
      intakeId: null,
      ownerOrganizationId: null,
      serviceOrganizationId: null,
      handlingResult: null,
      handlingStatus: null,
      closureStatus: null,
      closedAt: null,
      closureReason: null,
      currentRevisionNo: 0,
      deprecated: false,
      createdAt: new Date('2026-09-01T08:00:00.000Z'),
      updatedAt: new Date('2026-09-01T08:00:00.000Z'),
      ...overrides,
    }) as unknown as RepairRequestEntity;

  const modelEntity = (overrides: Partial<EquipmentModelEntity> = {}) =>
    ({
      id: 930001,
      modelCode: 'ASML-TWINSCAN-NXT-1980DI',
      modelName: 'NXT:1980Di',
      enabled: true,
      ...overrides,
    }) as unknown as EquipmentModelEntity;

  /** 读取 TypeORM FindOperator 私有字段（Raw 的注入参数 / In 的值集合） */
  const findOperatorField = (whereClause: unknown, key: string): unknown =>
    (whereClause as Record<string, unknown>)[key];

  it('列表默认仅未删除（deprecated = 0），固定排序与 OFFSET 分页透传', async () => {
    const requestRepo = makeRequestRepo();
    const service = new AdminRepairRequestQueryService(
      requestRepo as never,
      makeResponseRepo() as never,
      makeModelRepo() as never,
      makeRevisionRepo() as never,
      makeProcessEntryQuery() as never,
    );

    await service.listAll({ filter: {}, pagination, organizationId: null });

    expect(requestRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deprecated: false },
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: 0,
        take: 10,
      }),
    );
    expect(requestRepo.count).toHaveBeenCalledWith({ where: { deprecated: false } });
  });

  it('分页翻页：page = 3, pageSize = 20 时 skip = 40', async () => {
    const requestRepo = makeRequestRepo();
    const service = new AdminRepairRequestQueryService(
      requestRepo as never,
      makeResponseRepo() as never,
      makeModelRepo() as never,
      makeRevisionRepo() as never,
      makeProcessEntryQuery() as never,
    );

    await service.listAll({
      filter: {},
      pagination: { page: 3, pageSize: 20, withTotal: false },
      organizationId: null,
    });

    expect(requestRepo.find).toHaveBeenCalledWith(expect.objectContaining({ skip: 40, take: 20 }));
    expect(requestRepo.count).not.toHaveBeenCalled();
  });

  it('非法分页参数（0/负数）二级防御钳制，不产生负 skip / 零 take', async () => {
    const requestRepo = makeRequestRepo();
    const service = new AdminRepairRequestQueryService(
      requestRepo as never,
      makeResponseRepo() as never,
      makeModelRepo() as never,
      makeRevisionRepo() as never,
      makeProcessEntryQuery() as never,
    );

    await service.listAll({
      filter: {},
      pagination: { page: 0, pageSize: -5, withTotal: true },
      organizationId: null,
    });

    expect(requestRepo.find).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 1 }));
  });

  it('requestNo 走 Raw LIKE 且通配符转义；errorCode / isAccepted / equipmentModelId 等值透传', async () => {
    const requestRepo = makeRequestRepo();
    const service = new AdminRepairRequestQueryService(
      requestRepo as never,
      makeResponseRepo() as never,
      makeModelRepo() as never,
      makeRevisionRepo() as never,
      makeProcessEntryQuery() as never,
    );

    await service.listAll({
      filter: {
        requestNo: '100%_a\\b',
        errorCode: 'E-001',
        isAccepted: false,
        equipmentModelId: 930001,
      },
      pagination,
      organizationId: null,
    });

    const call = requestRepo.find.mock.calls[0][0];
    const rawParams = findOperatorField(call.where.requestNo, '_objectLiteralParameters') as {
      pattern?: string;
    };
    expect(rawParams.pattern).toBe('%100\\%\\_a\\\\b%');
    expect(call.where.errorCode).toBe('E-001');
    expect(call.where.isAccepted).toBe(false);
    expect(call.where.equipmentModelId).toBe(930001);
  });

  it('R6 末端防御：equipmentModelId / isAccepted 显式 null（若绕过适配层）不写入 where', async () => {
    const requestRepo = makeRequestRepo();
    const service = new AdminRepairRequestQueryService(
      requestRepo as never,
      makeResponseRepo() as never,
      makeModelRepo() as never,
      makeRevisionRepo() as never,
      makeProcessEntryQuery() as never,
    );

    await service.listAll({
      filter: {
        // 绕过类型系统模拟「null 未经映射边界规整直达本层」的第二道防线场景
        equipmentModelId: null as unknown as number,
        isAccepted: null as unknown as boolean,
      },
      pagination,
      organizationId: null,
    });

    const call = requestRepo.find.mock.calls[0][0];
    expect(call.where.equipmentModelId).toBeUndefined();
    expect(call.where.isAccepted).toBeUndefined();
  });

  it('customerAccountIds 收敛为 In 集合；时间范围收敛为 Between', async () => {
    const requestRepo = makeRequestRepo();
    const service = new AdminRepairRequestQueryService(
      requestRepo as never,
      makeResponseRepo() as never,
      makeModelRepo() as never,
      makeRevisionRepo() as never,
      makeProcessEntryQuery() as never,
    );
    const from = new Date('2026-09-01T00:00:00.000Z');
    const to = new Date('2026-09-30T23:59:59.000Z');

    await service.listAll({
      filter: { customerAccountIds: [900001, 900002], createdAtFrom: from, createdAtTo: to },
      pagination,
      organizationId: null,
    });

    const call = requestRepo.find.mock.calls[0][0];
    expect(findOperatorField(call.where.customerAccountId, '_value')).toEqual([900001, 900002]);
    expect(call.where.createdAt).toEqual(Between(from, to));
  });

  it('时间范围单端缺省收敛为开区间（下界纪元 / 上界当前时间）', async () => {
    const requestRepo = makeRequestRepo();
    const service = new AdminRepairRequestQueryService(
      requestRepo as never,
      makeResponseRepo() as never,
      makeModelRepo() as never,
      makeRevisionRepo() as never,
      makeProcessEntryQuery() as never,
    );
    const from = new Date('2026-09-01T00:00:00.000Z');
    const before = new Date();

    await service.listAll({
      filter: { createdAtFrom: from },
      pagination,
      organizationId: null,
    });

    const where = (requestRepo.find.mock.calls[0][0] as { where: { createdAt: unknown } }).where;
    const value = (where.createdAt as { value: Date[] }).value;
    // 下界为入参 from，上界取当前时间兜底（单端开区间）
    expect(value[0]).toEqual(from);
    expect(value[1].getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('customerAccountIds 空集合短路返回空页，不产生空 IN 查询', async () => {
    const requestRepo = makeRequestRepo();
    const service = new AdminRepairRequestQueryService(
      requestRepo as never,
      makeResponseRepo() as never,
      makeModelRepo() as never,
      makeRevisionRepo() as never,
      makeProcessEntryQuery() as never,
    );

    const page = await service.listAll({
      filter: { customerAccountIds: [] },
      pagination,
      organizationId: null,
    });

    expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 10 });
    expect(requestRepo.find).not.toHaveBeenCalled();
    expect(requestRepo.count).not.toHaveBeenCalled();
  });

  it('列表批量装配防 N+1：机型与最新回复各一次批量查询；机型缺失回落占位', async () => {
    const requestRepo = makeRequestRepo();
    requestRepo.find.mockResolvedValue([
      requestEntity({
        closureStatus: 'CLOSED',
        closedAt: new Date('2026-09-02T00:00:00.000Z'),
        handlingResult: 'FIXED',
        handlingStatus: 'COMPLETED',
      }),
      requestEntity({ id: 880002, equipmentModelId: 930001 }),
    ]);
    const modelRepo = makeModelRepo();
    modelRepo.find.mockResolvedValue([modelEntity()]);
    const responseRepo = makeResponseRepo();
    responseRepo.find.mockResolvedValue([
      { requestId: 880001, resolutionStatus: 'PENDING' },
      { requestId: 880001, resolutionStatus: 'RESOLVED' },
    ] as unknown);
    const service = new AdminRepairRequestQueryService(
      requestRepo as never,
      responseRepo as never,
      modelRepo as never,
      makeRevisionRepo() as never,
      makeProcessEntryQuery() as never,
    );

    const page = await service.listAll({ filter: {}, pagination, organizationId: null });

    // N+1 防护断言：2 条申请只触发 1 次机型批量与 1 次回复批量
    expect(modelRepo.find).toHaveBeenCalledTimes(1);
    expect(responseRepo.find).toHaveBeenCalledTimes(1);
    const inValue = findOperatorField(
      (modelRepo.find.mock.calls[0][0] as { where: { id: unknown } }).where.id,
      '_value',
    );
    expect(inValue).toEqual([930001]);
    // 最新回复状态取排序末条（DESC 排序后的第一条）
    expect(page.items[0].latestResolutionStatus).toBe('PENDING');
    expect(page.items[0]).toMatchObject({
      closureStatus: 'CLOSED',
      closedAt: new Date('2026-09-02T00:00:00.000Z'),
      handlingResult: 'FIXED',
      handlingStatus: 'COMPLETED',
    });
    expect(page.items[1].latestResolutionStatus).toBeNull();
    expect(page.items[1]).toMatchObject({
      closureStatus: null,
      closedAt: null,
      handlingResult: null,
      handlingStatus: null,
    });
  });

  it('摘要：不存在与已软删统一 NOT_FOUND（防删除状态探测），不发起装配查询', async () => {
    const requestRepo = makeRequestRepo();
    const modelRepo = makeModelRepo();
    const service = new AdminRepairRequestQueryService(
      requestRepo as never,
      makeResponseRepo() as never,
      modelRepo as never,
      makeRevisionRepo() as never,
      makeProcessEntryQuery() as never,
    );

    const notFound = await captureThrownError(service.findSummaryById(880001, null));
    expect(notFound).toBeInstanceOf(DomainError);
    expect((notFound as DomainError).code).toBe(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND);

    requestRepo.findOne.mockResolvedValue(requestEntity({ deprecated: true }));
    const deleted = await captureThrownError(service.findSummaryById(880001, null));
    expect((deleted as DomainError).code).toBe(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND);
    expect(modelRepo.findOne).not.toHaveBeenCalled();
  });

  it('摘要返回申请全貌（含正文与故障描述）与最新处理状态', async () => {
    const requestRepo = makeRequestRepo();
    requestRepo.findOne.mockResolvedValue(requestEntity());
    const modelRepo = makeModelRepo();
    modelRepo.findOne.mockResolvedValue(modelEntity());
    const responseRepo = makeResponseRepo();
    responseRepo.find.mockResolvedValue([
      { requestId: 880001, resolutionStatus: 'RESOLVED' },
    ] as unknown);
    const service = new AdminRepairRequestQueryService(
      requestRepo as never,
      responseRepo as never,
      modelRepo as never,
      makeRevisionRepo() as never,
      makeProcessEntryQuery() as never,
    );

    const summary = await service.findSummaryById(880001, null);

    expect(summary).toMatchObject({
      id: 880001,
      requestNo: 'RR-20260901-001',
      customerAccountId: 900001,
      errorCode: 'E-001',
      faultDescription: '描述',
      contentMd: '# 正文',
      latestResolutionStatus: 'RESOLVED',
    });
    expect(summary.equipmentModel.modelCode).toBe('ASML-TWINSCAN-NXT-1980DI');
  });

  it('二级管理员列表：有 intake 一致性 + 无 intake 历史两分支，分页 total 使用同一 where', async () => {
    const requestRepo = makeRequestRepo();
    const service = new AdminRepairRequestQueryService(
      requestRepo as never,
      makeResponseRepo() as never,
      makeModelRepo() as never,
      makeRevisionRepo() as never,
      makeProcessEntryQuery() as never,
    );

    await service.listAll({ filter: {}, pagination, organizationId: 700001 });

    const findArg = requestRepo.find.mock.calls[0][0] as {
      where: Array<Record<string, unknown>>;
      skip: number;
      take: number;
    };
    expect(findArg.where).toHaveLength(3);
    // 历史无 intake：service 优先
    expect(findArg.where[0]).toMatchObject({
      deprecated: false,
      intakeId: IsNull(),
      serviceOrganizationId: 700001,
    });
    // 历史无 intake：service 缺失回落 owner
    expect(findArg.where[1]).toMatchObject({
      deprecated: false,
      intakeId: IsNull(),
      serviceOrganizationId: IsNull(),
      ownerOrganizationId: 700001,
    });
    // 有 intake：工单 service = 本公司，且 EXISTS 约束 intake service = 本公司
    expect(findArg.where[2]).toMatchObject({
      deprecated: false,
      serviceOrganizationId: 700001,
    });
    const existsParams = findOperatorField(
      findArg.where[2].intakeId,
      '_objectLiteralParameters',
    ) as { organizationId?: number };
    expect(existsParams.organizationId).toBe(700001);
    // 组织范围条件与分页在同一查询下发，分页前完成过滤
    expect(findArg).toMatchObject({ skip: 0, take: 10 });
    // 分页 total 必须复用与列表相同的组织范围条件
    expect(requestRepo.count).toHaveBeenCalledWith({ where: findArg.where });
  });

  it('方案 B：intake 软删除不缩小列表/统计范围，EXISTS 不引用 deleted_at 且 total 同口径', async () => {
    const requestRepo = makeRequestRepo();
    const service = new AdminRepairRequestQueryService(
      requestRepo as never,
      makeResponseRepo() as never,
      makeModelRepo() as never,
      makeRevisionRepo() as never,
      makeProcessEntryQuery() as never,
    );

    await service.listAll({ filter: {}, pagination, organizationId: 700001 });

    const findArg = requestRepo.find.mock.calls[0][0] as {
      where: Array<Record<string, unknown>>;
    };
    expect(findArg.where).toHaveLength(3);
    const listExistsSql = (
      findOperatorField(findArg.where[2].intakeId, '_getSql') as (alias: string) => string
    )('`RepairRequestEntity`.`intake_id`');
    expect(listExistsSql).toContain('repair_request_intake');
    // 方案 B：已关联工单不因 intake.deleted_at 非空而从列表/统计中消失
    expect(listExistsSql).not.toMatch(/deleted_at/);
    expect(findArg.where[2]).not.toHaveProperty('deletedAt');
    expect(requestRepo.count).toHaveBeenCalledWith({ where: findArg.where });

    await service.countAll(700001);
    const statsWhere = requestRepo.count.mock.calls[1][0].where as Array<Record<string, unknown>>;
    expect(statsWhere).toHaveLength(3);
    const statsExistsSql = (
      findOperatorField(statsWhere[2].intakeId, '_getSql') as (alias: string) => string
    )('`RepairRequestEntity`.`intake_id`');
    expect(statsExistsSql).not.toMatch(/deleted_at/);
  });

  it('一级管理员列表：不附加组织条件，跨公司可见且 total 同口径', async () => {
    const requestRepo = makeRequestRepo();
    const service = new AdminRepairRequestQueryService(
      requestRepo as never,
      makeResponseRepo() as never,
      makeModelRepo() as never,
      makeRevisionRepo() as never,
      makeProcessEntryQuery() as never,
    );

    await service.listAll({ filter: {}, pagination, organizationId: null });

    const findArg = requestRepo.find.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(Array.isArray(findArg.where)).toBe(false);
    expect(findArg.where).toMatchObject({ deprecated: false });
    expect(findArg.where).not.toHaveProperty('serviceOrganizationId');
    expect(findArg.where).not.toHaveProperty('ownerOrganizationId');
    expect(requestRepo.count).toHaveBeenCalledWith({ where: findArg.where });
  });

  it('一级管理员详情可跨公司读取（组织 ID 只影响二级范围）', async () => {
    const requestRepo = makeRequestRepo();
    requestRepo.findOne.mockResolvedValue(
      requestEntity({ serviceOrganizationId: 700001, ownerOrganizationId: 700002 }),
    );
    const modelRepo = makeModelRepo();
    modelRepo.findOne.mockResolvedValue(modelEntity());
    const service = new AdminRepairRequestQueryService(
      requestRepo as never,
      makeResponseRepo() as never,
      modelRepo as never,
      makeRevisionRepo() as never,
      makeProcessEntryQuery() as never,
    );

    await expect(service.findSummaryById(880001, null)).resolves.toMatchObject({
      id: 880001,
    });
    expect(modelRepo.findOne).toHaveBeenCalledTimes(1);
  });

  it('二级管理员详情：无 intake 历史工单 service 为空时按 owner 可读，外公司统一 NOT_FOUND', async () => {
    const requestRepo = makeRequestRepo();
    requestRepo.findOne.mockResolvedValue(
      requestEntity({
        intakeId: null,
        serviceOrganizationId: null,
        ownerOrganizationId: 700001,
      }),
    );
    const modelRepo = makeModelRepo();
    modelRepo.findOne.mockResolvedValue(modelEntity());
    const service = new AdminRepairRequestQueryService(
      requestRepo as never,
      makeResponseRepo() as never,
      modelRepo as never,
      makeRevisionRepo() as never,
      makeProcessEntryQuery() as never,
    );

    await expect(service.findSummaryById(880001, 700001)).resolves.toMatchObject({
      id: 880001,
    });

    const denied = await captureThrownError(service.findSummaryById(880001, 700002));
    expect(denied).toBeInstanceOf(DomainError);
    expect((denied as DomainError).code).toBe(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND);
    expect(modelRepo.findOne).toHaveBeenCalledTimes(1);
    // 历史工单无 intake，不发起 intake 读取
    expect(requestRepo.manager.getRepository).not.toHaveBeenCalled();
  });

  it('二级管理员详情：无 intake 历史工单 service 有值时优先于 owner', async () => {
    const requestRepo = makeRequestRepo();
    requestRepo.findOne.mockResolvedValue(
      requestEntity({
        intakeId: null,
        serviceOrganizationId: 700001,
        ownerOrganizationId: 700002,
      }),
    );
    const modelRepo = makeModelRepo();
    modelRepo.findOne.mockResolvedValue(modelEntity());
    const service = new AdminRepairRequestQueryService(
      requestRepo as never,
      makeResponseRepo() as never,
      modelRepo as never,
      makeRevisionRepo() as never,
      makeProcessEntryQuery() as never,
    );

    await expect(service.findSummaryById(880001, 700001)).resolves.toMatchObject({
      id: 880001,
    });

    const denied = await captureThrownError(service.findSummaryById(880001, 700002));
    expect((denied as DomainError).code).toBe(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND);
  });

  const processEntryWithFile = () => ({
    id: '1',
    entryUuid: 'entry-uuid-1',
    requestId: 880001,
    operationText: '更换部件',
    testResult: null,
    occurredAt: null,
    timeSource: 'SERVER',
    fileId: 'file-1',
    versionNo: 1,
    createdAt: new Date('2026-09-02T00:00:00.000Z'),
    file: {
      fileId: 'file-1',
      originalFilename: 'a.pdf',
      mimeType: 'application/pdf',
      byteSize: 10,
      checksumSha256: 'checksum',
    },
  });

  const processEntryTextOnly = () => ({
    ...processEntryWithFile(),
    fileId: null,
    file: null,
  });

  const makeSummaryService = (
    requestRepo: ReturnType<typeof makeRequestRepo>,
    processEntryQuery: ReturnType<typeof makeProcessEntryQuery>,
  ) => {
    const modelRepo = makeModelRepo();
    modelRepo.findOne.mockResolvedValue(modelEntity());
    processEntryQuery.listByRequest.mockResolvedValue([processEntryWithFile()]);
    processEntryQuery.listByRequestTextOnly.mockResolvedValue([processEntryTextOnly()]);
    return new AdminRepairRequestQueryService(
      requestRepo as never,
      makeResponseRepo() as never,
      modelRepo as never,
      makeRevisionRepo() as never,
      processEntryQuery as never,
    );
  };

  /** 使用真实过程投影（仓储替身）验证详情展示，不经 listByRequest mock。 */
  const makeSummaryServiceWithProcessQuery = (
    requestRepo: ReturnType<typeof makeRequestRepo>,
    processEntryQuery: RepairProcessEntryQueryService,
  ) => {
    const modelRepo = makeModelRepo();
    modelRepo.findOne.mockResolvedValue(modelEntity());
    return new AdminRepairRequestQueryService(
      requestRepo as never,
      makeResponseRepo() as never,
      modelRepo as never,
      makeRevisionRepo() as never,
      processEntryQuery,
    );
  };

  const makeRealProcessEntryProjection = (rows: Array<Record<string, unknown>>) => {
    const queryBuilder = {
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    };
    const projection = new RepairProcessEntryQueryService({
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    } as never);
    return { projection, queryBuilder };
  };

  const makeRealProcessEntryQuery = (rows: Array<Record<string, unknown>>) =>
    makeRealProcessEntryProjection(rows).projection;

  /**
   * 管理员详情过程行（仓储替身原始行）。
   * businessId='880001' 表示原件已正式绑定当前工单。
   */
  const processRow = (overrides: Record<string, unknown> = {}) => ({
    id: '1',
    entryUuid: 'entry-uuid-1',
    requestId: '880001',
    operationText: '更换部件',
    testResult: null,
    occurredAt: null,
    timeSource: 'SERVER',
    fileId: 'file-1',
    versionNo: '1',
    createdAt: '2026-09-02T00:00:00.000Z',
    fileFileId: 'file-1',
    fileOriginalFilename: 'a.pdf',
    fileMimeType: 'application/pdf',
    fileByteSize: '10',
    fileChecksumSha256: 'checksum',
    fileStatus: 'VALID',
    fileBindingStatus: 'BOUND',
    fileVerifiedAt: '2026-09-02T00:00:00.000Z',
    fileBusinessId: '880001',
    fileBusinessType: 'REPAIR_PROCESS',
    ...overrides,
  });

  it('组合 a：service=A、intake=A、owner=B，二级管理员 A 应展示原件（与任务 11 授权一致）', async () => {
    const intakeRepo = makeIntakeRepo();
    intakeRepo.findOne.mockResolvedValue({ id: 660001, serviceOrganizationId: 700001 });
    const requestRepo = makeRequestRepo(intakeRepo);
    requestRepo.findOne.mockResolvedValue(
      requestEntity({
        intakeId: 660001,
        serviceOrganizationId: 700001,
        ownerOrganizationId: 700002,
      }),
    );
    const service = makeSummaryService(requestRepo, makeProcessEntryQuery());

    const summary = await service.findSummaryById(880001, 700001);

    expect(summary.processEntries[0].fileId).toBe('file-1');
    expect(summary.processEntries[0].file).toMatchObject({ fileId: 'file-1' });
  });

  it('组合 b：有 intake 但工单服务公司缺失，二级管理员失败关闭 NOT_FOUND，不回退 owner', async () => {
    const intakeRepo = makeIntakeRepo();
    intakeRepo.findOne.mockResolvedValue({ id: 660001, serviceOrganizationId: 700001 });
    const requestRepo = makeRequestRepo(intakeRepo);
    requestRepo.findOne.mockResolvedValue(
      requestEntity({
        intakeId: 660001,
        serviceOrganizationId: null,
        ownerOrganizationId: 700001,
      }),
    );
    const processEntryQuery = makeProcessEntryQuery();
    const service = makeSummaryService(requestRepo, processEntryQuery);

    const error = await captureThrownError(service.findSummaryById(880001, 700001));

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND);
    // 先读取 intake 归属事实，再失败关闭
    expect(intakeRepo.findOne).toHaveBeenCalledTimes(1);
    // 不读取内部过程或原件元数据
    expect(processEntryQuery.listByRequest).not.toHaveBeenCalled();
    expect(processEntryQuery.listByRequestTextOnly).not.toHaveBeenCalled();
  });

  it('组合 c：有 intake 但归属冲突（service=A、intake=B），二级管理员失败关闭 NOT_FOUND', async () => {
    const intakeRepo = makeIntakeRepo();
    intakeRepo.findOne.mockResolvedValue({ id: 660001, serviceOrganizationId: 700002 });
    const requestRepo = makeRequestRepo(intakeRepo);
    requestRepo.findOne.mockResolvedValue(
      requestEntity({
        intakeId: 660001,
        serviceOrganizationId: 700001,
        ownerOrganizationId: 700001,
      }),
    );
    const processEntryQuery = makeProcessEntryQuery();
    const service = makeSummaryService(requestRepo, processEntryQuery);

    const error = await captureThrownError(service.findSummaryById(880001, 700001));

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND);
    expect(processEntryQuery.listByRequest).not.toHaveBeenCalled();
    expect(processEntryQuery.listByRequestTextOnly).not.toHaveBeenCalled();
  });

  it('有 intake 但关联记录缺失：二级管理员失败关闭 NOT_FOUND，不回退 owner', async () => {
    const intakeRepo = makeIntakeRepo();
    intakeRepo.findOne.mockResolvedValue(null);
    const requestRepo = makeRequestRepo(intakeRepo);
    requestRepo.findOne.mockResolvedValue(
      requestEntity({
        intakeId: 660001,
        serviceOrganizationId: 700001,
        ownerOrganizationId: 700001,
      }),
    );
    const processEntryQuery = makeProcessEntryQuery();
    const service = makeSummaryService(requestRepo, processEntryQuery);

    const error = await captureThrownError(service.findSummaryById(880001, 700001));

    expect((error as DomainError).code).toBe(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND);
    expect(processEntryQuery.listByRequest).not.toHaveBeenCalled();
    expect(processEntryQuery.listByRequestTextOnly).not.toHaveBeenCalled();
  });

  it('方案 B：intake 已软删除但双方公司一致，二级管理员详情可用并展示原件', async () => {
    const intakeRepo = makeIntakeRepo();
    intakeRepo.findOne.mockResolvedValue({
      id: 660001,
      serviceOrganizationId: 700001,
      deletedAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    const requestRepo = makeRequestRepo(intakeRepo);
    requestRepo.findOne.mockResolvedValue(
      requestEntity({
        intakeId: 660001,
        serviceOrganizationId: 700001,
        ownerOrganizationId: 700002,
      }),
    );
    const service = makeSummaryService(requestRepo, makeProcessEntryQuery());

    const summary = await service.findSummaryById(880001, 700001);

    expect(summary.id).toBe(880001);
    expect(summary.processEntries[0].file).toMatchObject({ fileId: 'file-1' });
  });

  it('方案 B：intake 已软删除仍不放宽归属冲突，拒绝前不读取过程/原件', async () => {
    const intakeRepo = makeIntakeRepo();
    intakeRepo.findOne.mockResolvedValue({
      id: 660001,
      serviceOrganizationId: 700002,
      deletedAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    const requestRepo = makeRequestRepo(intakeRepo);
    requestRepo.findOne.mockResolvedValue(
      requestEntity({
        intakeId: 660001,
        serviceOrganizationId: 700001,
        ownerOrganizationId: 700001,
      }),
    );
    const processEntryQuery = makeProcessEntryQuery();
    const service = makeSummaryService(requestRepo, processEntryQuery);

    const error = await captureThrownError(service.findSummaryById(880001, 700001));

    expect((error as DomainError).code).toBe(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND);
    expect(processEntryQuery.listByRequest).not.toHaveBeenCalled();
    expect(processEntryQuery.listByRequestTextOnly).not.toHaveBeenCalled();
  });

  it('方案 B：intake 已软删除不改变跨公司拒绝（管理员不属于该公司）', async () => {
    const intakeRepo = makeIntakeRepo();
    intakeRepo.findOne.mockResolvedValue({
      id: 660001,
      serviceOrganizationId: 700001,
      deletedAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    const requestRepo = makeRequestRepo(intakeRepo);
    requestRepo.findOne.mockResolvedValue(
      requestEntity({
        intakeId: 660001,
        serviceOrganizationId: 700001,
        ownerOrganizationId: 700001,
      }),
    );
    const processEntryQuery = makeProcessEntryQuery();
    const service = makeSummaryService(requestRepo, processEntryQuery);

    const error = await captureThrownError(service.findSummaryById(880001, 700002));

    expect((error as DomainError).code).toBe(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND);
    expect(processEntryQuery.listByRequest).not.toHaveBeenCalled();
    expect(processEntryQuery.listByRequestTextOnly).not.toHaveBeenCalled();
  });

  it('方案 B：一级管理员不受 intake 软删除影响，且不读取 intake', async () => {
    const intakeRepo = makeIntakeRepo();
    intakeRepo.findOne.mockResolvedValue({
      id: 660001,
      serviceOrganizationId: 700001,
      deletedAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    const requestRepo = makeRequestRepo(intakeRepo);
    requestRepo.findOne.mockResolvedValue(
      requestEntity({
        intakeId: 660001,
        serviceOrganizationId: 700001,
        ownerOrganizationId: 700002,
      }),
    );
    const service = makeSummaryService(requestRepo, makeProcessEntryQuery());

    const summary = await service.findSummaryById(880001, null);

    expect(summary.processEntries[0].file).toMatchObject({ fileId: 'file-1' });
    expect(intakeRepo.findOne).not.toHaveBeenCalled();
  });

  it('方案 B：无 intake 历史工单 owner 回退可见且二级仅过程文本，不读取 intake', async () => {
    const intakeRepo = makeIntakeRepo();
    const requestRepo = makeRequestRepo(intakeRepo);
    requestRepo.findOne.mockResolvedValue(
      requestEntity({
        intakeId: null,
        serviceOrganizationId: null,
        ownerOrganizationId: 700001,
      }),
    );
    const processEntryQuery = makeProcessEntryQuery();
    const service = makeSummaryService(requestRepo, processEntryQuery);

    const summary = await service.findSummaryById(880001, 700001);

    expect(summary.id).toBe(880001);
    expect(summary.processEntries[0].file).toBeNull();
    expect(processEntryQuery.listByRequest).not.toHaveBeenCalled();
    expect(processEntryQuery.listByRequestTextOnly).toHaveBeenCalledWith(880001);
    expect(intakeRepo.findOne).not.toHaveBeenCalled();
  });

  it('一级管理员详情保留全部原件；无 intake 历史工单二级仅过程文本', async () => {
    const intakeRepo = makeIntakeRepo();
    const requestRepo = makeRequestRepo(intakeRepo);
    requestRepo.findOne.mockResolvedValue(
      requestEntity({
        intakeId: null,
        serviceOrganizationId: 700001,
        ownerOrganizationId: 700001,
      }),
    );
    const processEntryQuery = makeProcessEntryQuery();
    const service = makeSummaryService(requestRepo, processEntryQuery);

    const global = await service.findSummaryById(880001, null);
    expect(global.processEntries[0].file).toMatchObject({ fileId: 'file-1' });
    expect(processEntryQuery.listByRequest).toHaveBeenCalledTimes(1);
    expect(processEntryQuery.listByRequestTextOnly).not.toHaveBeenCalled();

    processEntryQuery.listByRequest.mockClear();
    processEntryQuery.listByRequestTextOnly.mockClear();
    const scoped = await service.findSummaryById(880001, 700001);
    expect(scoped.processEntries[0].file).toBeNull();
    expect(processEntryQuery.listByRequest).not.toHaveBeenCalled();
    expect(processEntryQuery.listByRequestTextOnly).toHaveBeenCalledWith(880001);
  });

  it('一级管理员：有效 BOUND 原件展示；INVALID 原件隐藏且保留过程文本', async () => {
    const requestRepo = makeRequestRepo();
    requestRepo.findOne.mockResolvedValue(requestEntity());
    const service = makeSummaryServiceWithProcessQuery(
      requestRepo,
      makeRealProcessEntryQuery([
        processRow(),
        processRow({
          id: '2',
          entryUuid: 'entry-uuid-2',
          operationText: '复测',
          versionNo: '2',
          fileStatus: 'FAILED',
        }),
      ]),
    );

    const summary = await service.findSummaryById(880001, null);

    expect(summary.processEntries[0].fileId).toBe('file-1');
    expect(summary.processEntries[0].file).toMatchObject({ fileId: 'file-1' });
    expect(summary.processEntries[1].fileId).toBeNull();
    expect(summary.processEntries[1].file).toBeNull();
    expect(summary.processEntries[1].operationText).toBe('复测');
    expect(summary.processEntries[1].versionNo).toBe(2);
    expect(JSON.stringify(summary.processEntries[1])).not.toContain('checksum');
  });

  it('一级管理员：verifiedAt 缺失、TEMPORARY 或 businessId 指向其他工单均隐藏原件', async () => {
    const requestRepo = makeRequestRepo();
    requestRepo.findOne.mockResolvedValue(requestEntity());
    const service = makeSummaryServiceWithProcessQuery(
      requestRepo,
      makeRealProcessEntryQuery([
        processRow({ id: '1', fileVerifiedAt: null }),
        processRow({ id: '2', entryUuid: 'entry-uuid-2', fileBindingStatus: 'TEMPORARY' }),
        processRow({ id: '3', entryUuid: 'entry-uuid-3', fileBusinessId: '880002' }),
      ]),
    );

    const summary = await service.findSummaryById(880001, null);

    expect(summary.processEntries).toHaveLength(3);
    for (const entry of summary.processEntries) {
      expect(entry.fileId).toBeNull();
      expect(entry.file).toBeNull();
      expect(entry.operationText).toBe('更换部件');
    }
  });

  it('二级管理员 A：service=A、intake=A 时有效原件展示，无效原件隐藏', async () => {
    const intakeRepo = makeIntakeRepo();
    intakeRepo.findOne.mockResolvedValue({ id: 660001, serviceOrganizationId: 700001 });
    const requestRepo = makeRequestRepo(intakeRepo);
    requestRepo.findOne.mockResolvedValue(
      requestEntity({
        intakeId: 660001,
        serviceOrganizationId: 700001,
        ownerOrganizationId: 700002,
      }),
    );
    const service = makeSummaryServiceWithProcessQuery(
      requestRepo,
      makeRealProcessEntryQuery([
        processRow(),
        processRow({
          id: '2',
          entryUuid: 'entry-uuid-2',
          operationText: '复测',
          fileStatus: 'INVALID',
        }),
      ]),
    );

    const summary = await service.findSummaryById(880001, 700001);

    expect(summary.processEntries[0].fileId).toBe('file-1');
    expect(summary.processEntries[0].file).toMatchObject({ fileId: 'file-1' });
    expect(summary.processEntries[1].fileId).toBeNull();
    expect(summary.processEntries[1].file).toBeNull();
    expect(summary.processEntries[1].operationText).toBe('复测');
  });

  it('二级管理员 A：有 intake 但 service=A、intake=B 时详情 NOT_FOUND，绝不回退 owner', async () => {
    const intakeRepo = makeIntakeRepo();
    intakeRepo.findOne.mockResolvedValue({ id: 660001, serviceOrganizationId: 700002 });
    const requestRepo = makeRequestRepo(intakeRepo);
    requestRepo.findOne.mockResolvedValue(
      requestEntity({
        intakeId: 660001,
        serviceOrganizationId: 700001,
        ownerOrganizationId: 700001,
      }),
    );
    const processEntryQuery = makeProcessEntryQuery();
    const service = makeSummaryService(requestRepo, processEntryQuery);

    const error = await captureThrownError(service.findSummaryById(880001, 700001));

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND);
    expect(processEntryQuery.listByRequest).not.toHaveBeenCalled();
    expect(processEntryQuery.listByRequestTextOnly).not.toHaveBeenCalled();
  });

  it('二级拒绝（service=A、intake=B）：先读 intake 授权事实，随后 NOT_FOUND 且不执行任何过程投影', async () => {
    const intakeRepo = makeIntakeRepo();
    intakeRepo.findOne.mockResolvedValue({ id: 660001, serviceOrganizationId: 700002 });
    const requestRepo = makeRequestRepo(intakeRepo);
    requestRepo.findOne.mockResolvedValue(
      requestEntity({
        intakeId: 660001,
        serviceOrganizationId: 700001,
        ownerOrganizationId: 700001,
      }),
    );
    const processEntryQuery = makeProcessEntryQuery();
    const service = makeSummaryService(requestRepo, processEntryQuery);

    const error = await captureThrownError(service.findSummaryById(880001, 700001));

    expect((error as DomainError).code).toBe(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND);
    // 组织授权（intake 读取）先于任何过程投影；失败后连文本投影也不执行
    expect(intakeRepo.findOne).toHaveBeenCalledTimes(1);
    expect(processEntryQuery.listByRequest).not.toHaveBeenCalled();
    expect(processEntryQuery.listByRequestTextOnly).not.toHaveBeenCalled();
  });

  it('二级允许（service=A、intake=A）：仍执行含原件事实的投影并展示有效原件', async () => {
    const intakeRepo = makeIntakeRepo();
    intakeRepo.findOne.mockResolvedValue({ id: 660001, serviceOrganizationId: 700001 });
    const requestRepo = makeRequestRepo(intakeRepo);
    requestRepo.findOne.mockResolvedValue(
      requestEntity({
        intakeId: 660001,
        serviceOrganizationId: 700001,
        ownerOrganizationId: 700002,
      }),
    );
    const { projection, queryBuilder } = makeRealProcessEntryProjection([processRow()]);
    const service = makeSummaryServiceWithProcessQuery(requestRepo, projection);

    const summary = await service.findSummaryById(880001, 700001);

    expect(summary.processEntries[0].fileId).toBe('file-1');
    expect(queryBuilder.leftJoin).toHaveBeenCalled();
    const selected = queryBuilder.select.mock.calls[0][0] as string[];
    expect(selected.join('\n')).toContain('entry.file_id AS fileId');
    expect(selected.join('\n')).toContain('file.original_filename AS fileOriginalFilename');
  });

  it('二级管理员 A：service=A、intake=A 但文件 businessId 指向其他工单时隐藏', async () => {
    const intakeRepo = makeIntakeRepo();
    intakeRepo.findOne.mockResolvedValue({ id: 660001, serviceOrganizationId: 700001 });
    const requestRepo = makeRequestRepo(intakeRepo);
    requestRepo.findOne.mockResolvedValue(
      requestEntity({
        intakeId: 660001,
        serviceOrganizationId: 700001,
        ownerOrganizationId: 700002,
      }),
    );
    const service = makeSummaryServiceWithProcessQuery(
      requestRepo,
      makeRealProcessEntryQuery([processRow({ fileBusinessId: '880002' })]),
    );

    const summary = await service.findSummaryById(880001, 700001);

    expect(summary.processEntries[0].fileId).toBeNull();
    expect(summary.processEntries[0].file).toBeNull();
  });

  it('统计口径与默认列表过滤一致：仅统计未删除申请', async () => {
    const requestRepo = makeRequestRepo();
    requestRepo.count.mockResolvedValue(7);
    const service = new AdminRepairRequestQueryService(
      requestRepo as never,
      makeResponseRepo() as never,
      makeModelRepo() as never,
      makeRevisionRepo() as never,
      makeProcessEntryQuery() as never,
    );

    await expect(service.countAll(null)).resolves.toBe(7);
    expect(requestRepo.count).toHaveBeenCalledWith({ where: { deprecated: false } });
  });
});
