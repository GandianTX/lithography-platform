// src/modules/lithography/queries/maintenance-report.query.service.spec.ts

/// <reference types="jest" />
import type { Repository } from 'typeorm';

import { MaintenanceReportQueryService } from './maintenance-report.query.service';

const REPORT_ID = 960001;
const ORGANIZATION_ID = 910001;
const ENGINEER_ACCOUNT_ID = 900001;

type FakeRepository = {
  findOne: jest.Mock;
  find: jest.Mock;
  count: jest.Mock;
};

const createFakeRepository = (findOneResult: unknown = null): FakeRepository => ({
  findOne: jest.fn().mockResolvedValue(findOneResult),
  find: jest.fn().mockResolvedValue([]),
  count: jest.fn().mockResolvedValue(0),
});

const buildService = (repositories: {
  report: FakeRepository;
  alarm: FakeRepository;
  step: FakeRepository;
  fault: FakeRepository;
  repairRequest: FakeRepository;
  equipmentModel: FakeRepository;
  attachment: FakeRepository;
  version: FakeRepository;
  versionAttachment: FakeRepository;
  review: FakeRepository;
}): MaintenanceReportQueryService =>
  new MaintenanceReportQueryService(
    repositories.report as unknown as Repository<never>,
    repositories.alarm as unknown as Repository<never>,
    repositories.step as unknown as Repository<never>,
    repositories.fault as unknown as Repository<never>,
    repositories.repairRequest as unknown as Repository<never>,
    repositories.equipmentModel as unknown as Repository<never>,
    repositories.attachment as unknown as Repository<never>,
    repositories.version as unknown as Repository<never>,
    repositories.versionAttachment as unknown as Repository<never>,
    repositories.review as unknown as Repository<never>,
  );

const buildRepositories = (reportFindOne: unknown = null) => ({
  report: createFakeRepository(reportFindOne),
  alarm: createFakeRepository(),
  step: createFakeRepository(),
  fault: createFakeRepository(),
  repairRequest: createFakeRepository(),
  equipmentModel: createFakeRepository(),
  attachment: createFakeRepository(),
  version: createFakeRepository(),
  versionAttachment: createFakeRepository(),
  review: createFakeRepository(),
});

describe('MaintenanceReportQueryService 授权范围读取', () => {
  it('最小归属事实只读取 id / 负责人 / 所属组织 / 状态', async () => {
    const repositories = buildRepositories({
      id: REPORT_ID,
      maintenanceEngineerAccountId: ENGINEER_ACCOUNT_ID,
      ownerOrganizationId: ORGANIZATION_ID,
      status: 'APPROVED',
    });
    const service = buildService(repositories);

    await expect(service.readReportOwnership(REPORT_ID)).resolves.toEqual({
      reportId: REPORT_ID,
      maintenanceEngineerAccountId: ENGINEER_ACCOUNT_ID,
      ownerOrganizationId: ORGANIZATION_ID,
      status: 'APPROVED',
    });
    expect(repositories.report.findOne).toHaveBeenCalledWith({
      where: { id: REPORT_ID },
      select: {
        id: true,
        maintenanceEngineerAccountId: true,
        ownerOrganizationId: true,
        status: true,
      },
    });
  });

  it('报告不存在时最小归属事实返回 null', async () => {
    const repositories = buildRepositories(null);
    const service = buildService(repositories);

    await expect(service.readReportOwnership(REPORT_ID)).resolves.toBeNull();
  });

  it('未传范围时根查询只按 id 过滤（兼容既有写路径调用）', async () => {
    const repositories = buildRepositories(null);
    const service = buildService(repositories);

    await service.readReport(REPORT_ID);

    expect(repositories.report.findOne).toHaveBeenCalledWith({ where: { id: REPORT_ID } });
  });

  it('传入范围时根查询同时携带组织谓词', async () => {
    const repositories = buildRepositories(null);
    const service = buildService(repositories);

    await service.readReport(REPORT_ID, undefined, { ownerOrganizationId: ORGANIZATION_ID });

    expect(repositories.report.findOne).toHaveBeenCalledWith({
      where: { id: REPORT_ID, ownerOrganizationId: ORGANIZATION_ID },
    });
  });

  it('详情读取携带组织与本人范围谓词', async () => {
    const repositories = buildRepositories(null);
    const service = buildService(repositories);

    await service.readReportDetail(REPORT_ID, undefined, {
      ownerOrganizationId: ORGANIZATION_ID,
      maintenanceEngineerAccountId: ENGINEER_ACCOUNT_ID,
    });

    expect(repositories.report.findOne).toHaveBeenCalledWith({
      where: {
        id: REPORT_ID,
        ownerOrganizationId: ORGANIZATION_ID,
        maintenanceEngineerAccountId: ENGINEER_ACCOUNT_ID,
      },
    });
  });

  it('范围外目标在根查询即返回空，且不触发报警/步骤/附件/版本/审核读取', async () => {
    const repositories = buildRepositories(null);
    const service = buildService(repositories);

    await expect(
      service.readReportDetail(REPORT_ID, undefined, {
        ownerOrganizationId: ORGANIZATION_ID + 1,
      }),
    ).resolves.toBeNull();

    expect(repositories.alarm.find).not.toHaveBeenCalled();
    expect(repositories.alarm.findOne).not.toHaveBeenCalled();
    expect(repositories.step.find).not.toHaveBeenCalled();
    expect(repositories.attachment.find).not.toHaveBeenCalled();
    expect(repositories.version.findOne).not.toHaveBeenCalled();
    expect(repositories.versionAttachment.find).not.toHaveBeenCalled();
    expect(repositories.review.find).not.toHaveBeenCalled();
    expect(repositories.review.findOne).not.toHaveBeenCalled();
  });
});

describe('MaintenanceReportQueryService.listMine（R052 本人资料记录谓词）', () => {
  const pagination = { page: 1, pageSize: 10, withTotal: true };

  /** 归一化 where（TypeORM 允许单对象或对象数组）便于断言 */
  const whereOf = (call: unknown): Record<string, unknown>[] => {
    const where = (call as { where: unknown }).where;
    return Array.isArray(where)
      ? (where as Record<string, unknown>[])
      : [where as Record<string, unknown>];
  };

  /** 递归展开 TypeORM FindOperator（Not(In([...])) 嵌套包装）取出状态集合 */
  const operatorValues = (operator: unknown): unknown[] => {
    const findOperator = operator as { value?: unknown };
    if (
      findOperator &&
      typeof findOperator === 'object' &&
      findOperator.value !== undefined &&
      !Array.isArray(findOperator.value)
    ) {
      return operatorValues(findOperator.value);
    }
    return findOperator.value as unknown[];
  };

  const statusValuesOf = (condition: Record<string, unknown>): unknown[] =>
    operatorValues(condition.status);

  const buildListService = () => {
    const repositories = buildRepositories(null);
    return { repositories, service: buildService(repositories) };
  };

  it('未完成筛选只按「本人草稿/退回」收敛：作者 + 本组织 + 草稿态状态集合', async () => {
    const { repositories, service } = buildListService();

    await service.listMine(ENGINEER_ACCOUNT_ID, ORGANIZATION_ID, pagination, {
      recordKind: 'DRAFT',
    });

    expect(repositories.report.find).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 10 }),
    );
    const conditions = whereOf(repositories.report.find.mock.calls[0][0]);
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toMatchObject({
      maintenanceEngineerAccountId: ENGINEER_ACCOUNT_ID,
      ownerOrganizationId: ORGANIZATION_ID,
    });
    expect(statusValuesOf(conditions[0])).toEqual(['DRAFT', 'RETURNED']);
  });

  it('已完成筛选 = 本人全部非草稿态（作者 + 本组织），不含任何他人记录分支', async () => {
    const { repositories, service } = buildListService();

    await service.listMine(ENGINEER_ACCOUNT_ID, ORGANIZATION_ID, pagination, {
      recordKind: 'FORMAL',
    });

    const conditions = whereOf(repositories.report.find.mock.calls[0][0]);
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toMatchObject({
      maintenanceEngineerAccountId: ENGINEER_ACCOUNT_ID,
      ownerOrganizationId: ORGANIZATION_ID,
    });
    expect(statusValuesOf(conditions[0])).toEqual(['DRAFT', 'RETURNED']);
  });

  it('默认（ALL）= 本人草稿 + 本人非草稿；本公司他人正式记录不再出现（页面 2026-11-21 口径）', async () => {
    const { repositories, service } = buildListService();

    await service.listMine(ENGINEER_ACCOUNT_ID, ORGANIZATION_ID, pagination, {});

    const conditions = whereOf(repositories.report.find.mock.calls[0][0]);
    expect(conditions).toHaveLength(2);
    // 页面只展示本人创建记录：每个分支都必须携带作者谓词，不存在纯组织分支
    for (const condition of conditions) {
      expect(condition).toMatchObject({
        maintenanceEngineerAccountId: ENGINEER_ACCOUNT_ID,
        ownerOrganizationId: ORGANIZATION_ID,
      });
    }
  });

  it('来源类型筛选下推到本人草稿与非草稿两个分支', async () => {
    const { repositories, service } = buildListService();

    await service.listMine(ENGINEER_ACCOUNT_ID, ORGANIZATION_ID, pagination, {
      sourceType: 'WORK_ORDER_SUMMARY',
    });

    const conditions = whereOf(repositories.report.find.mock.calls[0][0]);
    for (const condition of conditions) {
      expect(condition).toMatchObject({ sourceType: 'WORK_ORDER_SUMMARY' });
    }
  });

  it('标题关键词下推到两个分支：LIKE 恒在归属谓词内，通配符已转义', async () => {
    const { repositories, service } = buildListService();

    await service.listMine(ENGINEER_ACCOUNT_ID, ORGANIZATION_ID, pagination, {
      titleKeyword: '50%轴_异常',
    });

    const conditions = whereOf(repositories.report.find.mock.calls[0][0]);
    expect(conditions).toHaveLength(2);
    for (const condition of conditions) {
      expect(condition).toMatchObject({
        maintenanceEngineerAccountId: ENGINEER_ACCOUNT_ID,
        ownerOrganizationId: ORGANIZATION_ID,
      });
      // Raw 条件携带参数化 pattern：用户输入的 %/_ 已转义，不展开为通配
      // （FindOperator 注入参数存于私有字段，索引访问避免命名约定冲突，同 reference spec 模式）
      const title = condition.title as Record<string, unknown>;
      const rawParams = title['_objectLiteralParameters'] as { pattern?: string } | undefined;
      expect(rawParams?.pattern).toBe('%50\\%轴\\_异常%');
    }
  });

  it('count 与 find 使用同一含标题关键词的 where（total 与列表一致）', async () => {
    const { repositories, service } = buildListService();

    await service.listMine(ENGINEER_ACCOUNT_ID, ORGANIZATION_ID, pagination, {
      recordKind: 'DRAFT',
      titleKeyword: '光刻',
    });

    expect(repositories.report.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: (repositories.report.find.mock.calls[0][0] as { where: unknown }).where,
      }),
    );
  });

  it('一级管理员口径：不传公司谓词时只按作者本人收敛（平台级角色无业务所属公司）', async () => {
    const { repositories, service } = buildListService();

    await service.listMine(ENGINEER_ACCOUNT_ID, undefined, pagination, {});

    const conditions = whereOf(repositories.report.find.mock.calls[0][0]);
    expect(conditions).toHaveLength(2);
    for (const condition of conditions) {
      expect(condition).toMatchObject({ maintenanceEngineerAccountId: ENGINEER_ACCOUNT_ID });
      expect(condition).not.toHaveProperty('ownerOrganizationId');
    }
  });

  it('total 与列表共用同一 where：total 由同一谓词派生（R052 列表/total 一致）', async () => {
    const { repositories, service } = buildListService();
    repositories.report.count.mockResolvedValue(7);

    const result = await service.listMine(ENGINEER_ACCOUNT_ID, ORGANIZATION_ID, pagination, {});

    expect(repositories.report.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: (repositories.report.find.mock.calls[0][0] as { where: unknown }).where,
      }),
    );
    expect(result.total).toBe(7);
  });
});
