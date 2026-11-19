// src/modules/lithography/queries/engineer-repair-revision.query.service.spec.ts

import { PERMISSION_ERROR, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import type { UsecaseSession } from '@app-types/auth/session.types';

import { EngineerRepairRevisionQueryService } from './engineer-repair-revision.query.service';

type MockRepo = {
  find: jest.Mock;
  findOne: jest.Mock;
};

function repo(): MockRepo {
  return { find: jest.fn(), findOne: jest.fn() };
}

const ENGINEER_SESSION: UsecaseSession = {
  accountId: 7,
  roles: [IdentityTypeEnum.ENGINEER],
};

const CUSTOMER_SESSION: UsecaseSession = {
  accountId: 7,
  roles: [IdentityTypeEnum.CUSTOMER],
};

const REQUEST_ENTITY = {
  id: 123,
  deprecated: false,
  isAccepted: true,
  acceptedByEngineerAccountId: 7,
  intakeId: 5,
  serviceOrganizationId: 9,
};

function snapshot(input: {
  contentMd?: string;
  schemaVersion?: number;
  engineerName?: string | null;
  attachmentFileId?: string | null;
  steps?: unknown[];
  panels?: unknown[];
}): string {
  const schemaVersion = input.schemaVersion ?? 2;
  return JSON.stringify({
    schema_version: schemaVersion,
    request: {
      content_md: input.contentMd ?? '管理员可订正正文',
      handling_result: '已处理',
      closure_reason: '客户确认',
      maintenance_date: '2026-09-02',
      maintenance_engineer_name: input.engineerName ?? '陈工',
      reset_result: 'SUCCESS',
      supplementary_note: null,
      maintenance_version_no: 3,
      maintenance_attachment_file_id: input.attachmentFileId ?? 'file-secret',
    },
    ...(schemaVersion >= 2
      ? {
          diagnostic_steps: input.steps ?? [
            {
              id: 'step-1',
              step_no: 1,
              error_code: 'E-0001',
              part_name: '对准模块',
              action_text: '更换备件',
              result_code: 'PASS',
            },
          ],
          fault_panels: input.panels ?? [],
        }
      : {}),
    process_entries: [],
    responses: [],
  });
}

function revisionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    requestId: 123,
    revisionNo: 2,
    previousVersion: 1,
    reason: '修正维修步骤',
    actorAccountId: 42,
    createdAt: new Date('2026-09-03T10:00:00.000Z'),
    beforeSnapshot: snapshot({}),
    afterSnapshot: snapshot({ engineerName: '陈工（修订）' }),
    ...overrides,
  };
}

function makeService(revisionRepo: MockRepo): {
  service: EngineerRepairRevisionQueryService;
  requestRepo: MockRepo;
  intakeRepo: MockRepo;
} {
  const requestRepo = repo();
  const intakeRepo = repo();
  requestRepo.findOne.mockResolvedValue(REQUEST_ENTITY);
  intakeRepo.findOne.mockResolvedValue({ id: 5, serviceOrganizationId: 9 });
  return {
    service: new EngineerRepairRevisionQueryService(
      requestRepo as never,
      intakeRepo as never,
      revisionRepo as never,
    ),
    requestRepo,
    intakeRepo,
  };
}

describe('EngineerRepairRevisionQueryService', () => {
  it('接单工程师 + 可信厂家：返回最新在前历史，并标记可对比状态', async () => {
    const revisionRepo = repo();
    revisionRepo.find.mockResolvedValue([
      revisionRow(),
      revisionRow({
        id: 2,
        revisionNo: 1,
        previousVersion: 0,
        beforeSnapshot: snapshot({ schemaVersion: 1 }),
        afterSnapshot: snapshot({ schemaVersion: 1 }),
      }),
    ]);
    const { service } = makeService(revisionRepo);

    const result = await service.listForAcceptingEngineer({
      requestId: 123,
      session: ENGINEER_SESSION,
      viewerOrganizationId: 9,
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      revisionNo: 2,
      previousVersion: 1,
      hasComparableSnapshot: true,
      hasVisibleMaintenanceChange: true,
      compareUnavailableReason: null,
    });
    expect(result[1]).toMatchObject({
      revisionNo: 1,
      hasComparableSnapshot: false,
      hasVisibleMaintenanceChange: false,
      compareUnavailableReason: 'NO_COMPARABLE_SNAPSHOT',
    });
    expect(revisionRepo.find).toHaveBeenCalledWith({
      where: { requestId: 123 },
      order: { revisionNo: 'DESC' },
    });
  });

  it('可比但维修内容相同的修订：标记为无可见维修差异', async () => {
    const revisionRepo = repo();
    revisionRepo.find.mockResolvedValue([
      revisionRow({ beforeSnapshot: snapshot({}), afterSnapshot: snapshot({}) }),
    ]);
    const { service } = makeService(revisionRepo);

    const [item] = await service.listForAcceptingEngineer({
      requestId: 123,
      session: ENGINEER_SESSION,
      viewerOrganizationId: 9,
    });

    expect(item.hasComparableSnapshot).toBe(true);
    expect(item.hasVisibleMaintenanceChange).toBe(false);
    expect(item.compareUnavailableReason).toBe('NO_VISIBLE_MAINTENANCE_CHANGE');
  });

  it('非接单工程师：拒绝访问', async () => {
    const { service } = makeService(repo());

    await expect(
      service.listForAcceptingEngineer({
        requestId: 123,
        session: { ...ENGINEER_SESSION, accountId: 8 },
        viewerOrganizationId: 9,
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });
  });

  it('外厂家：拒绝访问', async () => {
    const { service } = makeService(repo());

    await expect(
      service.listForAcceptingEngineer({
        requestId: 123,
        session: ENGINEER_SESSION,
        viewerOrganizationId: 10,
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });
  });

  it('客户账号：拒绝访问', async () => {
    const { service } = makeService(repo());

    await expect(
      service.listForAcceptingEngineer({
        requestId: 123,
        session: CUSTOMER_SESSION,
        viewerOrganizationId: 9,
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });
  });

  it('服务公司与 intake 冲突：失败关闭', async () => {
    const revisionRepo = repo();
    const { service, intakeRepo } = makeService(revisionRepo);
    intakeRepo.findOne.mockResolvedValue({ id: 5, serviceOrganizationId: 10 });

    await expect(
      service.listForAcceptingEngineer({
        requestId: 123,
        session: ENGINEER_SESSION,
        viewerOrganizationId: 9,
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });
  });

  it('跨工单修订 ID：按修订不存在拒绝', async () => {
    const revisionRepo = repo();
    revisionRepo.findOne.mockResolvedValue(null);
    const { service } = makeService(revisionRepo);

    await expect(
      service.findRevisionForAcceptingEngineer({
        requestId: 123,
        revisionNo: 999,
        session: ENGINEER_SESSION,
        viewerOrganizationId: 9,
      }),
    ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.NOT_FOUND });
    expect(revisionRepo.findOne).toHaveBeenCalledWith({
      where: { requestId: 123, revisionNo: 999 },
    });
  });

  it('详情只返回工程师可见维修快照，不暴露附件、正文与管理员快照字段', async () => {
    const revisionRepo = repo();
    revisionRepo.findOne.mockResolvedValue(revisionRow());
    const { service } = makeService(revisionRepo);

    const detail = await service.findRevisionForAcceptingEngineer({
      requestId: 123,
      revisionNo: 2,
      session: ENGINEER_SESSION,
      viewerOrganizationId: 9,
    });

    expect(detail.before).toMatchObject({
      maintenanceDate: '2026-09-02',
      engineerName: '陈工',
      resetResult: 'SUCCESS',
    });
    expect(detail.before?.steps).toHaveLength(1);
    expect(detail.before).not.toHaveProperty('attachmentFileId');
    expect(detail.before).not.toHaveProperty('contentMd');
    expect(detail).not.toHaveProperty('request');
    expect(JSON.stringify(detail)).not.toContain('file-secret');
    expect(JSON.stringify(detail)).not.toContain('管理员可订正正文');
  });

  it('旧快照详情：两侧快照不可比，仍可查看已有维修字段', async () => {
    const revisionRepo = repo();
    revisionRepo.findOne.mockResolvedValue(
      revisionRow({
        beforeSnapshot: snapshot({ schemaVersion: 1, engineerName: '旧工程师' }),
        afterSnapshot: snapshot({ schemaVersion: 1, engineerName: '旧工程师' }),
      }),
    );
    const { service } = makeService(revisionRepo);

    const detail = await service.findRevisionForAcceptingEngineer({
      requestId: 123,
      revisionNo: 2,
      session: ENGINEER_SESSION,
      viewerOrganizationId: 9,
    });

    expect(detail.hasComparableSnapshot).toBe(false);
    expect(detail.hasVisibleMaintenanceChange).toBe(false);
    expect(detail.compareUnavailableReason).toBe('NO_COMPARABLE_SNAPSHOT');
    expect(detail.before?.engineerName).toBe('旧工程师');
  });
});
