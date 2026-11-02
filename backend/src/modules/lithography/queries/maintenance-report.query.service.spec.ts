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
};

const createFakeRepository = (findOneResult: unknown = null): FakeRepository => ({
  findOne: jest.fn().mockResolvedValue(findOneResult),
  find: jest.fn().mockResolvedValue([]),
});

const buildService = (repositories: {
  report: FakeRepository;
  alarm: FakeRepository;
  step: FakeRepository;
  attachment: FakeRepository;
  version: FakeRepository;
  versionAttachment: FakeRepository;
  review: FakeRepository;
}): MaintenanceReportQueryService =>
  new MaintenanceReportQueryService(
    repositories.report as unknown as Repository<never>,
    repositories.alarm as unknown as Repository<never>,
    repositories.step as unknown as Repository<never>,
    repositories.attachment as unknown as Repository<never>,
    repositories.version as unknown as Repository<never>,
    repositories.versionAttachment as unknown as Repository<never>,
    repositories.review as unknown as Repository<never>,
  );

const buildRepositories = (reportFindOne: unknown = null) => ({
  report: createFakeRepository(reportFindOne),
  alarm: createFakeRepository(),
  step: createFakeRepository(),
  attachment: createFakeRepository(),
  version: createFakeRepository(),
  versionAttachment: createFakeRepository(),
  review: createFakeRepository(),
});

describe('MaintenanceReportQueryService 授权范围读取', () => {
  it('最小归属事实只读取 id / 负责人 / 所属组织', async () => {
    const repositories = buildRepositories({
      id: REPORT_ID,
      maintenanceEngineerAccountId: ENGINEER_ACCOUNT_ID,
      ownerOrganizationId: ORGANIZATION_ID,
    });
    const service = buildService(repositories);

    await expect(service.readReportOwnership(REPORT_ID)).resolves.toEqual({
      reportId: REPORT_ID,
      maintenanceEngineerAccountId: ENGINEER_ACCOUNT_ID,
      ownerOrganizationId: ORGANIZATION_ID,
    });
    expect(repositories.report.findOne).toHaveBeenCalledWith({
      where: { id: REPORT_ID },
      select: { id: true, maintenanceEngineerAccountId: true, ownerOrganizationId: true },
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
