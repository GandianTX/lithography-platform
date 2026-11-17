/// <reference types="jest" />
import { PERMISSION_ERROR } from '@core/common/errors/domain-error';
import { EngineerResolutionStatus } from '@app-types/models/repair-request.types';
import { In, type Repository } from 'typeorm';
import { EngineerResponseEntity } from '../entities/engineer-response.entity';
import { EquipmentModelEntity } from '../entities/equipment-model.entity';
import { RepairRequestEntity } from '../entities/repair-request.entity';
import { RepairRequestIntakeEntity } from '../entities/repair-request-intake.entity';
import { RepairProcessEntryQueryService } from './repair-process-entry.query.service';
import { RepairRequestQueryService } from './repair-request.query.service';

type PartialRequest = Partial<RepairRequestEntity>;

const makeRequest = (overrides: PartialRequest = {}): RepairRequestEntity => ({
  id: 1,
  requestNo: '920_001',
  intakeId: null,
  customerOrganizationId: null,
  serviceOrganizationId: null,
  closureStatus: null,
  closedAt: null,
  closureReason: null,
  isHistorical: false,
  currentRevisionNo: 0,
  customerAccountId: 10,
  equipmentModelId: 5,
  errorCode: 'E-01',
  faultDescription: '无法曝光',
  contentMd: '# 维修申请',
  createdAt: new Date('2026-08-30T00:00:00.000Z'),
  isAccepted: false,
  acceptedByEngineerAccountId: null,
  acceptedAt: null,
  deprecated: false,
  deletedAt: null,
  ownerOrganizationId: null,
  handlingResult: null,
  handlingStatus: null,
  handlingRecordedAt: null,
  handlingRecordedByAccountId: null,
  handlingEndedAt: null,
  ...overrides,
});

const makeResponse = (overrides: Partial<EngineerResponseEntity> = {}): EngineerResponseEntity => ({
  id: 1,
  requestId: 1,
  engineerAccountId: 20,
  customerAccountId: 10,
  resolutionStatus: EngineerResolutionStatus.PENDING,
  responseText: '已收到',
  createdAt: new Date('2026-08-30T01:00:00.000Z'),
  ...overrides,
});

const makeModel = (overrides: Partial<EquipmentModelEntity> = {}): EquipmentModelEntity =>
  ({
    id: 5,
    modelCode: 'LITHO-9000',
    modelName: '光刻机 9000',
    enabled: true,
    sortOrder: 1,
    ...overrides,
  }) as EquipmentModelEntity;

const customerSession = { accountId: 10, roles: ['CUSTOMER'] };
const engineerSession = { accountId: 20, roles: ['ENGINEER'] };
const superAdminSession = { accountId: 99, roles: ['SUPER_ADMIN'] };

describe('RepairRequestQueryService', () => {
  let requestRepository: ReturnType<typeof createMockRepository>;
  let responseRepository: ReturnType<typeof createMockRepository>;
  let equipmentModelRepository: ReturnType<typeof createMockRepository>;
  let intakeRepository: ReturnType<typeof createMockRepository>;
  let service: RepairRequestQueryService;

  beforeEach(() => {
    requestRepository = createMockRepository();
    responseRepository = createMockRepository();
    equipmentModelRepository = createMockRepository();
    intakeRepository = createMockRepository();
    service = new RepairRequestQueryService(
      requestRepository as unknown as Repository<RepairRequestEntity>,
      responseRepository as unknown as Repository<EngineerResponseEntity>,
      equipmentModelRepository as unknown as Repository<EquipmentModelEntity>,
      intakeRepository as unknown as Repository<RepairRequestIntakeEntity>,
      {
        listByRequest: jest.fn().mockResolvedValue([]),
      } as unknown as RepairProcessEntryQueryService,
    );
    // 列表装配默认空集合，单测内按需覆盖
    equipmentModelRepository.find.mockResolvedValue([]);
    responseRepository.find.mockResolvedValue([]);
  });

  const makeIntake = (
    overrides: Partial<RepairRequestIntakeEntity> = {},
  ): RepairRequestIntakeEntity =>
    ({
      id: 3,
      customerOrganizationId: 910001,
      serviceOrganizationId: 77,
      ...overrides,
    }) as unknown as RepairRequestIntakeEntity;

  /** 构造工程师入口可见的工单：工单与 intake 服务公司一致（默认 77） */
  const makeEngineerVisibleRequest = (overrides: PartialRequest = {}): RepairRequestEntity => {
    const entity = makeRequest({ intakeId: 3, serviceOrganizationId: 77, ...overrides });
    intakeRepository.findOne.mockResolvedValue(
      makeIntake({ serviceOrganizationId: entity.serviceOrganizationId ?? 77 }),
    );
    return entity;
  };

  /** 工程师列表查询构造器：链式方法可断言，终端方法返回给定数据 */
  const makeListQueryBuilder = (
    entities: RepairRequestEntity[] = [],
    total = 0,
  ): Record<string, jest.Mock> => {
    const queryBuilder: Record<string, jest.Mock> = {} as Record<string, jest.Mock>;
    const chain = () => queryBuilder;
    for (const method of [
      'innerJoin',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'skip',
      'take',
    ]) {
      queryBuilder[method] = jest.fn(chain);
    }
    queryBuilder.getMany = jest.fn().mockResolvedValue(entities);
    queryBuilder.getCount = jest.fn().mockResolvedValue(total);
    queryBuilder.clone = jest.fn(() => ({ getCount: queryBuilder.getCount }));
    return queryBuilder;
  };

  const andWhereCalls = (queryBuilder: Record<string, jest.Mock>) =>
    queryBuilder.andWhere.mock.calls as [string, Record<string, unknown>?][];

  describe('listByCustomer', () => {
    it('仅查询本人且未删除的申请，排序固定 createdAt DESC + id DESC', async () => {
      requestRepository.find.mockResolvedValue([]);

      await service.listByCustomer({
        customerAccountId: 10,
        pagination: { page: 2, pageSize: 5, withTotal: false },
      });

      expect(requestRepository.find).toHaveBeenCalledWith({
        where: { customerAccountId: 10, deprecated: false },
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: 5,
        take: 5,
      });
      expect(requestRepository.count).not.toHaveBeenCalled();
    });

    it('withTotal=true 时附带 count 并回填 total', async () => {
      requestRepository.find.mockResolvedValue([makeRequest()]);
      requestRepository.count.mockResolvedValue(3);
      equipmentModelRepository.find.mockResolvedValue([makeModel()]);

      const result = await service.listByCustomer({
        customerAccountId: 10,
        pagination: { page: 1, pageSize: 10, withTotal: true },
      });

      expect(requestRepository.count).toHaveBeenCalledWith({
        where: { customerAccountId: 10, deprecated: false },
      });
      expect(result.total).toBe(3);
    });

    it('页码越界向下钳制为第一页（分页边界）', async () => {
      requestRepository.find.mockResolvedValue([]);

      const result = await service.listByCustomer({
        customerAccountId: 10,
        pagination: { page: 0, pageSize: -3, withTotal: false },
      });

      expect(requestRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 1 }),
      );
      expect(result).toMatchObject({ page: 1, pageSize: 1, items: [] });
    });

    it('列表项批量装配机型与最新处理状态（多回复取倒序首条）', async () => {
      requestRepository.find.mockResolvedValue([
        makeRequest({ id: 1 }),
        makeRequest({ id: 2, requestNo: '920_002' }),
      ]);
      equipmentModelRepository.find.mockResolvedValue([makeModel({ id: 5 })]);
      // 倒序返回：申请 1 的最新回复是 RESOLVED（id=9 在前），申请 2 无回复
      responseRepository.find.mockResolvedValue([
        makeResponse({ id: 9, requestId: 1, resolutionStatus: EngineerResolutionStatus.RESOLVED }),
        makeResponse({ id: 8, requestId: 1, resolutionStatus: EngineerResolutionStatus.PENDING }),
      ]);

      const result = await service.listByCustomer({
        customerAccountId: 10,
        pagination: { page: 1, pageSize: 10, withTotal: false },
      });

      expect(equipmentModelRepository.find).toHaveBeenCalledWith({ where: { id: In([5]) } });
      expect(responseRepository.find).toHaveBeenCalledWith({
        where: { requestId: In([1, 2]) },
        order: { createdAt: 'DESC', id: 'DESC' },
      });
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({
        id: 1,
        equipmentModel: { id: 5, modelCode: 'LITHO-9000', modelName: '光刻机 9000' },
        latestResolutionStatus: EngineerResolutionStatus.RESOLVED,
      });
      expect(result.items[1]).toMatchObject({ id: 2, latestResolutionStatus: null });
      // 不返回归属类账号 ID
      expect(result.items[0]).not.toHaveProperty('customerAccountId');
      expect(result.items[0]).not.toHaveProperty('acceptedByEngineerAccountId');
    });
  });

  describe('listByEngineer 四态（可信服务公司）', () => {
    it('ALL 只查本人可信服务公司，并强制 intake 服务公司一致', async () => {
      const queryBuilder = makeListQueryBuilder();
      requestRepository.createQueryBuilder.mockReturnValue(queryBuilder);

      await service.listByEngineer({
        engineerAccountId: 20,
        scope: 'ALL',
        filter: {},
        pagination: { page: 1, pageSize: 10, withTotal: false },
        viewerOrganizationId: 77,
      });

      expect(requestRepository.createQueryBuilder).toHaveBeenCalledWith('request');
      // 内连接同时约束 intake 存在且两处服务公司一致，冲突/缺失工单不会进入任何视角
      expect(queryBuilder.innerJoin).toHaveBeenCalledWith(
        RepairRequestIntakeEntity,
        'intake',
        'intake.id = request.intakeId AND intake.serviceOrganizationId = request.serviceOrganizationId',
      );
      expect(andWhereCalls(queryBuilder)).toContainEqual([
        'request.serviceOrganizationId = :viewerOrganizationId',
        { viewerOrganizationId: 77 },
      ]);
      expect(andWhereCalls(queryBuilder).some(([sql]) => sql.includes('request.isAccepted'))).toBe(
        false,
      );
      expect(queryBuilder.orderBy).toHaveBeenCalledWith('request.createdAt', 'DESC');
      expect(queryBuilder.addOrderBy).toHaveBeenCalledWith('request.id', 'DESC');
    });

    it('AVAILABLE 只查可信服务公司内未接单', async () => {
      const queryBuilder = makeListQueryBuilder();
      requestRepository.createQueryBuilder.mockReturnValue(queryBuilder);

      await service.listByEngineer({
        engineerAccountId: 20,
        scope: 'AVAILABLE',
        filter: {},
        pagination: { page: 1, pageSize: 10, withTotal: false },
        viewerOrganizationId: 77,
      });

      expect(andWhereCalls(queryBuilder)).toContainEqual([
        'request.isAccepted = :isAccepted',
        { isAccepted: false },
      ]);
    });

    it('MINE 只查可信服务公司内本人已接单（不再包含无归属存量兜底）', async () => {
      const queryBuilder = makeListQueryBuilder();
      requestRepository.createQueryBuilder.mockReturnValue(queryBuilder);

      await service.listByEngineer({
        engineerAccountId: 20,
        scope: 'MINE',
        filter: {},
        pagination: { page: 1, pageSize: 10, withTotal: false },
        viewerOrganizationId: 77,
      });

      expect(andWhereCalls(queryBuilder)).toContainEqual([
        'request.acceptedByEngineerAccountId = :engineerAccountId',
        { engineerAccountId: 20 },
      ]);
      expect(andWhereCalls(queryBuilder).some(([sql]) => sql.includes('request.isAccepted'))).toBe(
        false,
      );
    });

    it('TAKEN_BY_OTHER 只查可信服务公司内他人已接单', async () => {
      const queryBuilder = makeListQueryBuilder();
      requestRepository.createQueryBuilder.mockReturnValue(queryBuilder);

      await service.listByEngineer({
        engineerAccountId: 20,
        scope: 'TAKEN_BY_OTHER',
        filter: {},
        pagination: { page: 1, pageSize: 10, withTotal: false },
        viewerOrganizationId: 77,
      });

      expect(andWhereCalls(queryBuilder)).toContainEqual([
        'request.isAccepted = :isAccepted',
        { isAccepted: true },
      ]);
      expect(andWhereCalls(queryBuilder)).toContainEqual([
        'request.acceptedByEngineerAccountId <> :engineerAccountId',
        { engineerAccountId: 20 },
      ]);
    });

    it('设备型号与客户账号筛选进入查询，先筛选后分页计数', async () => {
      const queryBuilder = makeListQueryBuilder([], 2);
      requestRepository.createQueryBuilder.mockReturnValue(queryBuilder);

      const result = await service.listByEngineer({
        engineerAccountId: 20,
        scope: 'ALL',
        filter: { equipmentModelId: 5, customerAccountIds: [10, 11] },
        pagination: { page: 2, pageSize: 5, withTotal: true },
        viewerOrganizationId: 77,
      });

      expect(andWhereCalls(queryBuilder)).toContainEqual([
        'request.equipmentModelId = :equipmentModelId',
        { equipmentModelId: 5 },
      ]);
      expect(andWhereCalls(queryBuilder)).toContainEqual([
        'request.customerAccountId IN (:...customerAccountIds)',
        { customerAccountIds: [10, 11] },
      ]);
      expect(queryBuilder.skip).toHaveBeenCalledWith(5);
      expect(queryBuilder.take).toHaveBeenCalledWith(5);
      expect(queryBuilder.getCount).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ total: 2, page: 2, pageSize: 5 });
    });

    it('客户账号筛选为空集合时直接空页且不查库', async () => {
      const result = await service.listByEngineer({
        engineerAccountId: 20,
        scope: 'ALL',
        filter: { customerAccountIds: [] },
        pagination: { page: 1, pageSize: 10, withTotal: true },
        viewerOrganizationId: 77,
      });

      expect(result).toMatchObject({ items: [], total: 0 });
      expect(requestRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('无组织上下文：任何视角均空页且不查库（不把归属缺失当作全库可见）', async () => {
      for (const scope of ['ALL', 'AVAILABLE', 'MINE', 'TAKEN_BY_OTHER'] as const) {
        const result = await service.listByEngineer({
          engineerAccountId: 20,
          scope,
          filter: {},
          pagination: { page: 1, pageSize: 10, withTotal: true },
        });

        expect(result).toMatchObject({ items: [], total: 0, page: 1, pageSize: 10 });
      }
      expect(requestRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('列表项批量装配机型/末条状态并携带归属账号 ID（供 usecase 富集，不直接对外）', async () => {
      const queryBuilder = makeListQueryBuilder([
        makeRequest({ id: 1 }),
        makeRequest({
          id: 2,
          isAccepted: true,
          acceptedByEngineerAccountId: 21,
          acceptedAt: new Date('2026-08-31T00:00:00.000Z'),
          closureStatus: 'CLOSED',
          closedAt: new Date('2026-09-01T00:00:00.000Z'),
          handlingResult: 'INTERRUPTED',
          handlingStatus: 'IN_PROGRESS',
        }),
      ]);
      requestRepository.createQueryBuilder.mockReturnValue(queryBuilder);
      equipmentModelRepository.find.mockResolvedValue([makeModel()]);

      const result = await service.listByEngineer({
        engineerAccountId: 20,
        scope: 'ALL',
        filter: {},
        pagination: { page: 1, pageSize: 10, withTotal: false },
        viewerOrganizationId: 77,
      });

      expect(result.items[0]).toMatchObject({
        id: 1,
        equipmentModel: { id: 5, modelCode: 'LITHO-9000', modelName: '光刻机 9000' },
        customerAccountId: 10,
        acceptedByEngineerAccountId: null,
      });
      expect(result.items[1]).toMatchObject({
        id: 2,
        customerAccountId: 10,
        acceptedByEngineerAccountId: 21,
        closureStatus: 'CLOSED',
        closedAt: new Date('2026-09-01T00:00:00.000Z'),
        handlingResult: 'INTERRUPTED',
        handlingStatus: 'IN_PROGRESS',
      });
    });
  });

  describe('findDetail 读权限矩阵', () => {
    it('申请不存在时统一拒绝（防探测）', async () => {
      requestRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findDetail({ requestId: 99, session: customerSession, scope: 'CUSTOMER' }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });
    });

    it('CUSTOMER 本人申请可读（客户入口）', async () => {
      requestRepository.findOne.mockResolvedValue(makeRequest());
      equipmentModelRepository.findOne.mockResolvedValue(makeModel());
      responseRepository.find.mockResolvedValue([]);

      const result = await service.findDetail({
        requestId: 1,
        session: customerSession,
        scope: 'CUSTOMER',
      });

      expect(result).toMatchObject({
        id: 1,
        requestNo: '920_001',
        equipmentModel: { id: 5, modelCode: 'LITHO-9000', modelName: '光刻机 9000' },
        latestResolutionStatus: null,
        responses: [],
      });
    });

    it('CUSTOMER 他人申请拒绝', async () => {
      requestRepository.findOne.mockResolvedValue(makeRequest({ customerAccountId: 11 }));

      await expect(
        service.findDetail({ requestId: 1, session: customerSession, scope: 'CUSTOMER' }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });
    });

    it('CUSTOMER 本人已删除申请拒绝', async () => {
      requestRepository.findOne.mockResolvedValue(
        makeRequest({ deprecated: true, deletedAt: new Date() }),
      );

      await expect(
        service.findDetail({ requestId: 1, session: customerSession, scope: 'CUSTOMER' }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });
    });

    it('纯 CUSTOMER 走工程师入口拒绝（入口 scope 隔离有效身份）', async () => {
      requestRepository.findOne.mockResolvedValue(makeRequest());

      await expect(
        service.findDetail({ requestId: 1, session: customerSession, scope: 'ENGINEER' }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });
    });

    it('ENGINEER 可信服务公司内未接单且未删除的申请可读（待接单池）', async () => {
      requestRepository.findOne.mockResolvedValue(makeEngineerVisibleRequest());
      equipmentModelRepository.findOne.mockResolvedValue(makeModel());
      responseRepository.find.mockResolvedValue([]);

      await expect(
        service.findDetail({
          requestId: 1,
          session: engineerSession,
          scope: 'ENGINEER',
          viewerOrganizationId: 77,
        }),
      ).resolves.toMatchObject({ id: 1 });
    });

    it('ENGINEER 未接单但已删除的申请拒绝', async () => {
      requestRepository.findOne.mockResolvedValue(
        makeRequest({ deprecated: true, deletedAt: new Date() }),
      );

      await expect(
        service.findDetail({ requestId: 1, session: engineerSession, scope: 'ENGINEER' }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });
    });

    it('ENGINEER 本人已接单且可信服务公司一致：可读', async () => {
      requestRepository.findOne.mockResolvedValue(
        makeEngineerVisibleRequest({
          isAccepted: true,
          acceptedByEngineerAccountId: 20,
          acceptedAt: new Date('2026-08-30T02:00:00.000Z'),
        }),
      );
      equipmentModelRepository.findOne.mockResolvedValue(makeModel());
      responseRepository.find.mockResolvedValue([]);

      await expect(
        service.findDetail({
          requestId: 1,
          session: engineerSession,
          scope: 'ENGINEER',
          viewerOrganizationId: 77,
        }),
      ).resolves.toMatchObject({ isAccepted: true, acceptedAt: expect.any(Date) });
    });

    it('ENGINEER 已删除申请统一不可读（含已接单场景；写契约保证已接单不可删除，此例防口径漂移）', async () => {
      requestRepository.findOne.mockResolvedValue(
        makeRequest({
          isAccepted: true,
          acceptedByEngineerAccountId: 20,
          deprecated: true,
          deletedAt: new Date(),
        }),
      );

      await expect(
        service.findDetail({ requestId: 1, session: engineerSession, scope: 'ENGINEER' }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });
    });

    it('ENGINEER 可信服务公司内他人已接单的申请可读（只读视角，写权限由写用例独立拒绝）', async () => {
      requestRepository.findOne.mockResolvedValue(
        makeEngineerVisibleRequest({
          isAccepted: true,
          acceptedByEngineerAccountId: 21,
        }),
      );
      equipmentModelRepository.findOne.mockResolvedValue(makeModel());
      responseRepository.find.mockResolvedValue([]);

      const result = await service.findDetail({
        requestId: 1,
        session: engineerSession,
        scope: 'ENGINEER',
        viewerOrganizationId: 77,
      });

      expect(result).toMatchObject({
        id: 1,
        isAccepted: true,
        customerAccountId: 10,
        acceptedByEngineerAccountId: 21,
      });
    });

    it('SUPER_ADMIN 按角色继承可读本组织未接单申请（负责人裁定 2：工程师入口）', async () => {
      requestRepository.findOne.mockResolvedValue(makeEngineerVisibleRequest());
      equipmentModelRepository.findOne.mockResolvedValue(makeModel());
      responseRepository.find.mockResolvedValue([]);

      await expect(
        service.findDetail({
          requestId: 1,
          session: superAdminSession,
          scope: 'ENGINEER',
          viewerOrganizationId: 77,
        }),
      ).resolves.toMatchObject({ id: 1 });
    });

    it('SUPER_ADMIN 继承工程师身份可读本组织他人已接单申请（读继承；写仍拒绝）', async () => {
      requestRepository.findOne.mockResolvedValue(
        makeEngineerVisibleRequest({
          isAccepted: true,
          acceptedByEngineerAccountId: 21,
        }),
      );
      equipmentModelRepository.findOne.mockResolvedValue(makeModel());
      responseRepository.find.mockResolvedValue([]);

      await expect(
        service.findDetail({
          requestId: 1,
          session: superAdminSession,
          scope: 'ENGINEER',
          viewerOrganizationId: 77,
        }),
      ).resolves.toMatchObject({ id: 1, isAccepted: true });
    });

    it('SUPER_ADMIN 客户入口仅见本人名下申请（超管无客户申请时不可见他人申请）', async () => {
      requestRepository.findOne.mockResolvedValue(makeRequest({ customerAccountId: 10 }));

      await expect(
        service.findDetail({ requestId: 1, session: superAdminSession, scope: 'CUSTOMER' }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });
    });

    it('ENGINEER 客户公司 A、服务公司 B：工程师属于 B 且两处一致 → 可读', async () => {
      requestRepository.findOne.mockResolvedValue(
        makeEngineerVisibleRequest({
          intakeId: 3,
          serviceOrganizationId: 88,
          isAccepted: true,
          acceptedByEngineerAccountId: 20,
        }),
      );
      equipmentModelRepository.findOne.mockResolvedValue(makeModel());
      responseRepository.find.mockResolvedValue([]);

      await expect(
        service.findDetail({
          requestId: 1,
          session: engineerSession,
          scope: 'ENGINEER',
          viewerOrganizationId: 88,
        }),
      ).resolves.toMatchObject({ id: 1 });
    });

    it('ENGINEER intake 缺失但仍是原接单人：拒绝（不按历史接单人兜底）', async () => {
      requestRepository.findOne.mockResolvedValue(
        makeRequest({
          intakeId: null,
          serviceOrganizationId: null,
          isAccepted: true,
          acceptedByEngineerAccountId: 20,
        }),
      );

      await expect(
        service.findDetail({
          requestId: 1,
          session: engineerSession,
          scope: 'ENGINEER',
          viewerOrganizationId: null,
        }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });
    });

    it('ENGINEER 服务公司缺失（工单列有 intake 但服务公司为空）：拒绝', async () => {
      requestRepository.findOne.mockResolvedValue(
        makeRequest({ intakeId: 3, serviceOrganizationId: null }),
      );

      await expect(
        service.findDetail({
          requestId: 1,
          session: engineerSession,
          scope: 'ENGINEER',
          viewerOrganizationId: 77,
        }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });
    });

    it('ENGINEER 工单与 intake 两处服务公司冲突：拒绝', async () => {
      requestRepository.findOne.mockResolvedValue(
        makeRequest({ intakeId: 3, serviceOrganizationId: 77 }),
      );
      intakeRepository.findOne.mockResolvedValue(makeIntake({ serviceOrganizationId: 88 }));

      await expect(
        service.findDetail({
          requestId: 1,
          session: engineerSession,
          scope: 'ENGINEER',
          viewerOrganizationId: 77,
        }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });
    });

    it('ENGINEER 无归属存量且未接单：拒绝（不因组织列缺失向全体工程师开放）', async () => {
      requestRepository.findOne.mockResolvedValue(makeRequest({ ownerOrganizationId: null }));

      await expect(
        service.findDetail({
          requestId: 1,
          session: engineerSession,
          scope: 'ENGINEER',
          viewerOrganizationId: null,
        }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });
    });

    it('ENGINEER 同组织工单可读', async () => {
      requestRepository.findOne.mockResolvedValue(makeEngineerVisibleRequest());
      equipmentModelRepository.findOne.mockResolvedValue(makeModel());
      responseRepository.find.mockResolvedValue([]);

      await expect(
        service.findDetail({
          requestId: 1,
          session: engineerSession,
          scope: 'ENGINEER',
          viewerOrganizationId: 77,
        }),
      ).resolves.toMatchObject({ id: 1 });
    });

    it('ENGINEER 跨服务公司工单拒绝（与不存在统一表述）', async () => {
      requestRepository.findOne.mockResolvedValue(
        makeRequest({ intakeId: 3, serviceOrganizationId: 78 }),
      );
      intakeRepository.findOne.mockResolvedValue(makeIntake({ serviceOrganizationId: 78 }));

      await expect(
        service.findDetail({
          requestId: 1,
          session: engineerSession,
          scope: 'ENGINEER',
          viewerOrganizationId: 77,
        }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });
    });
  });

  describe('findDetail 维修过程原件展示（共享投影）', () => {
    const FILE_ID = 'file-1';

    /** 使用真实过程投影（仓储替身）验证工程师详情，不经 listByRequest mock。 */
    const makeRealProcessEntryQuery = (rows: Array<Record<string, unknown>>) => {
      const queryBuilder = {
        leftJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rows),
      };
      return new RepairProcessEntryQueryService({
        createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      } as never);
    };

    const processRow = (overrides: Record<string, unknown> = {}) => ({
      id: '1',
      entryUuid: 'entry-uuid-1',
      requestId: '1',
      operationText: '更换部件',
      testResult: null,
      occurredAt: null,
      timeSource: 'SERVER',
      fileId: FILE_ID,
      versionNo: '1',
      createdAt: '2026-08-30T03:00:00.000Z',
      fileFileId: FILE_ID,
      fileOriginalFilename: 'a.pdf',
      fileMimeType: 'application/pdf',
      fileByteSize: '10',
      fileChecksumSha256: 'checksum',
      fileStatus: 'VALID',
      fileBindingStatus: 'BOUND',
      fileVerifiedAt: '2026-08-30T03:00:00.000Z',
      fileBusinessId: '1',
      fileBusinessType: 'REPAIR_PROCESS',
      ...overrides,
    });

    const useProjection = (rows: Array<Record<string, unknown>>) => {
      const projection = makeRealProcessEntryQuery(rows);
      service = new RepairRequestQueryService(
        requestRepository as unknown as Repository<RepairRequestEntity>,
        responseRepository as unknown as Repository<EngineerResponseEntity>,
        equipmentModelRepository as unknown as Repository<EquipmentModelEntity>,
        intakeRepository as unknown as Repository<RepairRequestIntakeEntity>,
        projection,
      );
      return projection;
    };

    it('接单工程师本人：有效 BOUND 原件展示；INVALID 原件隐藏且保留过程文本', async () => {
      requestRepository.findOne.mockResolvedValue(
        makeEngineerVisibleRequest({ isAccepted: true, acceptedByEngineerAccountId: 20 }),
      );
      equipmentModelRepository.findOne.mockResolvedValue(makeModel());
      responseRepository.find.mockResolvedValue([]);
      const projection = useProjection([
        processRow(),
        processRow({
          id: '2',
          entryUuid: 'entry-uuid-2',
          operationText: '复测',
          versionNo: '2',
          fileStatus: 'FAILED',
        }),
      ]);
      const readSpy = jest.spyOn(projection, 'listByRequest');
      const textSpy = jest.spyOn(projection, 'listByRequestTextOnly');

      const result = await service.findDetail({
        requestId: 1,
        session: engineerSession,
        scope: 'ENGINEER',
        viewerOrganizationId: 77,
      });

      expect(result.processEntries[0].fileId).toBe(FILE_ID);
      expect(result.processEntries[0].file).toMatchObject({ fileId: FILE_ID });
      expect(result.processEntries[1].fileId).toBeNull();
      expect(result.processEntries[1].file).toBeNull();
      expect(result.processEntries[1].operationText).toBe('复测');
      expect(result.processEntries[1].versionNo).toBe(2);
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(textSpy).not.toHaveBeenCalled();
    });

    it('接单工程师本人：verifiedAt 缺失、TEMPORARY、businessId 其他工单均隐藏原件', async () => {
      requestRepository.findOne.mockResolvedValue(
        makeEngineerVisibleRequest({ isAccepted: true, acceptedByEngineerAccountId: 20 }),
      );
      equipmentModelRepository.findOne.mockResolvedValue(makeModel());
      responseRepository.find.mockResolvedValue([]);
      useProjection([
        processRow({ id: '1', fileVerifiedAt: null }),
        processRow({ id: '2', entryUuid: 'entry-uuid-2', fileBindingStatus: 'TEMPORARY' }),
        processRow({ id: '3', entryUuid: 'entry-uuid-3', fileBusinessId: '2' }),
      ]);

      const result = await service.findDetail({
        requestId: 1,
        session: engineerSession,
        scope: 'ENGINEER',
        viewerOrganizationId: 77,
      });

      expect(result.processEntries).toHaveLength(3);
      for (const entry of result.processEntries) {
        expect(entry.fileId).toBeNull();
        expect(entry.file).toBeNull();
      }
    });

    it('非接单工程师（同公司）可读工单但过程与原件为空，不调用过程投影', async () => {
      requestRepository.findOne.mockResolvedValue(
        makeEngineerVisibleRequest({ isAccepted: true, acceptedByEngineerAccountId: 21 }),
      );
      equipmentModelRepository.findOne.mockResolvedValue(makeModel());
      responseRepository.find.mockResolvedValue([]);
      const projection = useProjection([processRow()]);
      const readSpy = jest.spyOn(projection, 'listByRequest');
      const textSpy = jest.spyOn(projection, 'listByRequestTextOnly');

      const result = await service.findDetail({
        requestId: 1,
        session: engineerSession,
        scope: 'ENGINEER',
        viewerOrganizationId: 77,
      });

      expect(result.processEntries).toEqual([]);
      expect(readSpy).not.toHaveBeenCalled();
      expect(textSpy).not.toHaveBeenCalled();
    });

    it('跨服务公司详情拒绝，且不读取任何过程/原件投影', async () => {
      requestRepository.findOne.mockResolvedValue(
        makeEngineerVisibleRequest({ isAccepted: true, acceptedByEngineerAccountId: 20 }),
      );
      equipmentModelRepository.findOne.mockResolvedValue(makeModel());
      responseRepository.find.mockResolvedValue([]);
      const projection = useProjection([processRow()]);
      const readSpy = jest.spyOn(projection, 'listByRequest');
      const textSpy = jest.spyOn(projection, 'listByRequestTextOnly');

      await expect(
        service.findDetail({
          requestId: 1,
          session: engineerSession,
          scope: 'ENGINEER',
          viewerOrganizationId: 88,
        }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });

      expect(readSpy).not.toHaveBeenCalled();
      expect(textSpy).not.toHaveBeenCalled();
    });
  });

  describe('findDetail 回复时间线与末条状态口径', () => {
    it('回复按 createdAt ASC + id ASC 读取，最新状态取末条', async () => {
      requestRepository.findOne.mockResolvedValue(
        makeEngineerVisibleRequest({ isAccepted: true, acceptedByEngineerAccountId: 20 }),
      );
      equipmentModelRepository.findOne.mockResolvedValue(makeModel());
      responseRepository.find.mockResolvedValue([
        makeResponse({ id: 8, resolutionStatus: EngineerResolutionStatus.PENDING }),
        makeResponse({
          id: 9,
          resolutionStatus: EngineerResolutionStatus.RESOLVED,
          createdAt: new Date('2026-08-30T02:00:00.000Z'),
        }),
      ]);

      const result = await service.findDetail({
        requestId: 1,
        session: engineerSession,
        scope: 'ENGINEER',
        viewerOrganizationId: 77,
      });

      expect(responseRepository.find).toHaveBeenCalledWith({
        where: { requestId: 1 },
        order: { createdAt: 'ASC', id: 'ASC' },
      });
      expect(result.latestResolutionStatus).toBe(EngineerResolutionStatus.RESOLVED);
      expect(result.responses).toHaveLength(2);
      expect(result.responses[0].id).toBe(8);
      expect(result.responses[1].id).toBe(9);
    });

    it('无回复时最新状态为 null 且回复为空数组', async () => {
      requestRepository.findOne.mockResolvedValue(makeRequest());
      equipmentModelRepository.findOne.mockResolvedValue(makeModel());
      responseRepository.find.mockResolvedValue([]);

      const result = await service.findDetail({
        requestId: 1,
        session: customerSession,
        scope: 'CUSTOMER',
      });

      expect(result.latestResolutionStatus).toBeNull();
      expect(result.responses).toEqual([]);
    });
  });
});
