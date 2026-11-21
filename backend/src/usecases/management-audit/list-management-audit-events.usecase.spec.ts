// src/usecases/management-audit/list-management-audit-events.usecase.spec.ts

import { MANAGEMENT_AUDIT_ERROR, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import type { PaginationParams } from '@core/pagination/pagination.types';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { ManagementAuditEventReadModel } from '@src/modules/lithography/management-audit.types';
import type { ManagementAuditEventQueryService } from '@src/modules/lithography/queries/management-audit-event.query.service';
import type { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import {
  createLevelTwoAdminSession,
  createSuperAdminSession,
  createUnauthorizedSessions,
} from '../../../test/support/account/admin-user.fixture';
import { ListManagementAuditEventsUsecase } from './list-management-audit-events.usecase';

const offsetPagination = (overrides: Partial<PaginationParams> = {}): PaginationParams =>
  ({
    mode: 'OFFSET',
    page: 1,
    pageSize: 10,
    withTotal: true,
    ...overrides,
  }) as PaginationParams;

const makeReadModel = (
  overrides: Partial<ManagementAuditEventReadModel> = {},
): ManagementAuditEventReadModel => ({
  eventId: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
  actorAccountId: 42,
  actorAdminLevel: 2,
  organizationId: 700002,
  operation: 'RESTORE_LOCAL_BUSINESS',
  targetType: 'BACKUP_RESTORE_RUN',
  targetId: 'restore-0001',
  result: 'FAILED',
  detail: { reason: '保护副本校验失败', stage: 'PRECHECK' },
  createdAt: new Date('2026-11-18T10:00:00.000Z'),
  ...overrides,
});

/**
 * 关键操作记录列表用例单测（任务 10 S1.1／S1.3 的用例层部分）。
 *
 * 覆盖：精确授权失败关闭且不触发查询、一级全公司（归一 null）、二级可信公司、
 * 仅 OFFSET 与页大小钳制、跨域富集批量一次、输出剥离操作者账号 ID。
 */
describe('ListManagementAuditEventsUsecase', () => {
  const createHarness = () => {
    const queryService = {
      listEvents: jest.fn().mockResolvedValue({ items: [makeReadModel()], total: 1 }),
    };
    const accountQueryService = {
      findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map([[42, '薛工']])),
    };
    const organizationQueryService = {
      findOrganizationNamesByIds: jest
        .fn()
        .mockResolvedValue(new Map([[700002, '开发联调公司 B']])),
    };

    const usecase = new ListManagementAuditEventsUsecase(
      queryService as unknown as ManagementAuditEventQueryService,
      accountQueryService as unknown as AccountQueryService,
      organizationQueryService as unknown as OrganizationQueryService,
    );

    return { usecase, queryService, accountQueryService, organizationQueryService };
  };

  it('一级管理员：即使会话带有成员公司也按全公司查询', async () => {
    const { usecase, queryService } = createHarness();

    await usecase.execute({
      session: createSuperAdminSession({ adminLevel: 1, adminOrganizationId: 700001 }),
      pagination: offsetPagination(),
    });

    expect(queryService.listEvents).toHaveBeenCalledWith({
      organizationId: null,
      pagination: { page: 1, pageSize: 10, withTotal: true },
    });
  });

  it('二级管理员：只按请求期可信公司查询', async () => {
    const { usecase, queryService } = createHarness();

    await usecase.execute({
      session: createLevelTwoAdminSession({ adminOrganizationId: 700002 }),
      pagination: offsetPagination(),
    });

    expect(queryService.listEvents).toHaveBeenCalledWith({
      organizationId: 700002,
      pagination: { page: 1, pageSize: 10, withTotal: true },
    });
  });

  it('等级缺失或非法时失败关闭，且不发起查询', async () => {
    const { usecase, queryService } = createHarness();

    await expect(
      usecase.execute({
        session: createSuperAdminSession({ adminLevel: null }),
        pagination: offsetPagination(),
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

    await expect(
      usecase.execute({
        session: createSuperAdminSession({ adminLevel: 3 }),
        pagination: offsetPagination(),
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

    await expect(
      usecase.execute({
        session: createLevelTwoAdminSession({ adminOrganizationId: null }),
        pagination: offsetPagination(),
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

    expect(queryService.listEvents).not.toHaveBeenCalled();
  });

  it.each(createUnauthorizedSessions())('%s 无查询资格且不发起查询', async (_label, session) => {
    const { usecase, queryService } = createHarness();

    await expect(
      usecase.execute({ session, pagination: offsetPagination() }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

    expect(queryService.listEvents).not.toHaveBeenCalled();
  });

  it('CURSOR 模式显式拒绝，不静默降级', async () => {
    const { usecase, queryService } = createHarness();

    await expect(
      usecase.execute({
        session: createSuperAdminSession(),
        pagination: { mode: 'CURSOR', limit: 10 },
      }),
    ).rejects.toMatchObject({ code: MANAGEMENT_AUDIT_ERROR.INVALID_PARAMS });

    expect(queryService.listEvents).not.toHaveBeenCalled();
  });

  it('页大小钳制到 100，页码最小为 1', async () => {
    const { usecase, queryService } = createHarness();

    await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination({ page: 0, pageSize: 500 }),
    });

    expect(queryService.listEvents).toHaveBeenCalledWith({
      organizationId: null,
      pagination: { page: 1, pageSize: 100, withTotal: true },
    });
  });

  it('客户端未要求 total 时仍固定统计，避免分页控件拿到 0', async () => {
    const { usecase, queryService } = createHarness();

    await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination({ withTotal: false }),
    });

    expect(queryService.listEvents).toHaveBeenCalledWith({
      organizationId: null,
      pagination: { page: 1, pageSize: 10, withTotal: true },
    });
  });

  it('展示富集：昵称与公司名各批量一次，输出不携带操作者账号 ID', async () => {
    const { usecase, accountQueryService, organizationQueryService } = createHarness();

    const page = await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination(),
    });

    expect(accountQueryService.findNicknamesByAccountIds).toHaveBeenCalledTimes(1);
    expect(accountQueryService.findNicknamesByAccountIds).toHaveBeenCalledWith([42]);
    expect(organizationQueryService.findOrganizationNamesByIds).toHaveBeenCalledTimes(1);
    expect(organizationQueryService.findOrganizationNamesByIds).toHaveBeenCalledWith([700002]);

    expect(page.items[0]).toMatchObject({
      eventId: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
      occurredAt: new Date('2026-11-18T10:00:00.000Z'),
      actorAdminLevel: 2,
      actorNickname: '薛工',
      organizationId: 700002,
      organizationName: '开发联调公司 B',
      operation: 'RESTORE_LOCAL_BUSINESS',
      result: 'FAILED',
    });
    expect(Object.keys(page.items[0])).not.toContain('actorAccountId');
  });

  it('公司为空与昵称缺失分别回落：公司名为 null、昵称为占位文案', async () => {
    const { usecase, queryService, accountQueryService } = createHarness();
    queryService.listEvents.mockResolvedValue({
      items: [
        makeReadModel({ organizationId: null, actorAccountId: 43 }),
        makeReadModel({ eventId: 'second', organizationId: 800001 }),
      ],
      total: 2,
    });
    accountQueryService.findNicknamesByAccountIds.mockResolvedValue(new Map());

    const page = await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination(),
    });

    expect(page.items[0].organizationName).toBeNull();
    expect(page.items[0].actorNickname).toBe('未知管理员');
    expect(page.items[1].organizationName).toBeNull();
  });

  it('空列表不触发富集查询，total 原样透传', async () => {
    const { usecase, queryService, accountQueryService, organizationQueryService } =
      createHarness();
    queryService.listEvents.mockResolvedValue({ items: [], total: 0 });

    const page = await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination(),
    });

    expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 10 });
    expect(accountQueryService.findNicknamesByAccountIds).not.toHaveBeenCalled();
    expect(organizationQueryService.findOrganizationNamesByIds).not.toHaveBeenCalled();
  });
});
