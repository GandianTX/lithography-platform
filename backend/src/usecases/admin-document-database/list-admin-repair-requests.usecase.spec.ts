// src/usecases/admin-document-database/list-admin-repair-requests.usecase.spec.ts

import { IdentityTypeEnum } from '@app-types/models/account.types';
import type { OffsetParams, PaginationParams } from '@core/pagination/pagination.types';
import { PERMISSION_ERROR } from '@core/common/errors/domain-error';
import type {
  AdminRepairRequestListItemQueryResult,
  AdminRepairRequestListPage,
} from '@src/modules/lithography/admin-document-database.types';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { AdminRepairRequestQueryService } from '@src/modules/lithography/queries/admin-repair-request.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  captureThrownError,
  createSuperAdminSession,
  createUnauthorizedSessions,
} from '../../../test/support/account/admin-user.fixture';
import { ListAdminRepairRequestsUsecase } from './list-admin-repair-requests.usecase';

/**
 * PR3 S4：管理员全局维修申请列表用例单测。
 *
 * 覆盖计划表 S4.1/S4.3 的用例层语义：精确授权先行（失败关闭时不触发任何查询）、
 * 仅 OFFSET 分页、页大小钳制与 GraphQL 边界对齐、跨账户域关键字解析
 * （超限显式拒绝 / 无命中短路，M-02 口径）、富集批量一次（防 N+1）。
 */
describe('ListAdminRepairRequestsUsecase', () => {
  const offsetPagination = (overrides: Partial<OffsetParams> = {}): PaginationParams => ({
    mode: 'OFFSET' as const,
    page: 1,
    pageSize: 10,
    withTotal: true,
    ...overrides,
  });

  const makeListPage = (): Omit<AdminRepairRequestListPage, 'items'> & {
    items: AdminRepairRequestListItemQueryResult[];
  } => ({
    items: [
      {
        id: 880001,
        requestNo: 'RR-20260901-001',
        customerAccountId: 900001,
        equipmentModel: { id: 930001, modelCode: 'M', modelName: 'NXT' },
        errorCode: 'E-001',
        createdAt: new Date('2026-09-01T08:00:00.000Z'),
        isAccepted: false,
        acceptedAt: null,
        acceptedByEngineerAccountId: null,
        latestResolutionStatus: null,
      },
    ],
    total: 1,
    page: 1,
    pageSize: 10,
  });

  const adminRepairRequestQueryService = {
    listAll: jest.fn().mockResolvedValue(makeListPage()),
  } as unknown as AdminRepairRequestQueryService;

  const accountQueryService = {
    findAdminLevelByAccountId: jest.fn().mockResolvedValue(1),
    findAccountIdsByDisplayKeyword: jest
      .fn()
      .mockResolvedValue({ accountIds: [], totalMatched: 0 }),
    findAccountDisplayInfosByAccountIds: jest.fn().mockResolvedValue(new Map()),
  } as unknown as AccountQueryService;

  const trustedOrganizationContext = {
    resolveForAccount: jest.fn().mockResolvedValue({
      organizationId: 700001,
      memberRole: IdentityTypeEnum.SUPER_ADMIN,
    }),
  } as unknown as TrustedOrganizationContextQueryService;

  const usecase = new ListAdminRepairRequestsUsecase(
    adminRepairRequestQueryService,
    accountQueryService,
    trustedOrganizationContext,
  );

  beforeEach(() => {
    (adminRepairRequestQueryService.listAll as jest.Mock)
      .mockClear()
      .mockResolvedValue(makeListPage());
    (accountQueryService.findAccountIdsByDisplayKeyword as jest.Mock)
      .mockClear()
      .mockResolvedValue({ accountIds: [], totalMatched: 0 });
    (accountQueryService.findAccountDisplayInfosByAccountIds as jest.Mock)
      .mockClear()
      .mockResolvedValue(new Map());
    (accountQueryService.findAdminLevelByAccountId as jest.Mock).mockClear().mockResolvedValue(1);
    (trustedOrganizationContext.resolveForAccount as jest.Mock)
      .mockClear()
      .mockResolvedValue({ organizationId: 700001, memberRole: IdentityTypeEnum.SUPER_ADMIN });
  });

  it.each(createUnauthorizedSessions().map(([label, session]) => ({ label, session })))(
    '$label 时授权先行拒绝，不触发本域与账户域任何查询',
    async ({ session }) => {
      const error = (await captureThrownError(
        usecase.execute({ session: session, pagination: offsetPagination() }),
      )) as { code?: string };

      expect(error.code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
      expect(adminRepairRequestQueryService.listAll).not.toHaveBeenCalled();
      expect(accountQueryService.findAccountIdsByDisplayKeyword).not.toHaveBeenCalled();
    },
  );

  it('非 OFFSET 分页拒绝（管理员聚合仅支持 OFFSET）', async () => {
    const error = (await captureThrownError(
      usecase.execute({
        session: createSuperAdminSession(),
        pagination: { mode: 'CURSOR', limit: 10 } as unknown as PaginationParams,
      }),
    )) as { code?: string; message?: string };

    expect(error.message).toContain('仅支持 OFFSET 分页');
    expect(adminRepairRequestQueryService.listAll).not.toHaveBeenCalled();
  });

  it('页大小钳制与 GraphQL 边界 @Max(100) 对齐（超出收敛为 100）', async () => {
    await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination({ pageSize: 500 }),
    });

    const call = (adminRepairRequestQueryService.listAll as jest.Mock).mock.calls[0][0];
    expect(call.pagination.pageSize).toBe(100);
  });

  it('customerKeyword 经账户域解析为账号 ID 集合后进 SQL 筛选', async () => {
    (accountQueryService.findAccountIdsByDisplayKeyword as jest.Mock).mockResolvedValue({
      accountIds: [900001],
      totalMatched: 1,
    });

    await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination(),
      filter: { customerKeyword: '  客户甲  ' },
    });

    expect(accountQueryService.findAccountIdsByDisplayKeyword).toHaveBeenCalledWith('客户甲', 1000);
    const call = (adminRepairRequestQueryService.listAll as jest.Mock).mock.calls[0][0];
    expect(call.filter.customerAccountIds).toEqual([900001]);
  });

  it('customerKeyword 无命中时短路返回空页，不发起本域查询', async () => {
    const page = await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination(),
      filter: { customerKeyword: '不存在' },
    });

    expect(page).toMatchObject({ items: [], total: 0 });
    expect(adminRepairRequestQueryService.listAll).not.toHaveBeenCalled();
  });

  it('customerKeyword 命中数超上限时显式拒绝（不静默截断漏数，M-02）', async () => {
    (accountQueryService.findAccountIdsByDisplayKeyword as jest.Mock).mockResolvedValue({
      accountIds: Array.from({ length: 1000 }, (_, i) => i + 1),
      totalMatched: 1001,
    });

    const error = (await captureThrownError(
      usecase.execute({
        session: createSuperAdminSession(),
        pagination: offsetPagination(),
        filter: { customerKeyword: '超宽关键字' },
      }),
    )) as { code?: string; message?: string };

    expect(error.message).toContain('命中账号过多');
    expect(adminRepairRequestQueryService.listAll).not.toHaveBeenCalled();
  });

  it('富集恰一次批量账户查询（防 N+1），展示昵称进入对外 View', async () => {
    (accountQueryService.findAccountDisplayInfosByAccountIds as jest.Mock).mockResolvedValue(
      new Map([[900001, { nickname: '客户甲', companyName: '甲公司' }]]),
    );

    const page = await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination(),
    });

    expect(accountQueryService.findAccountDisplayInfosByAccountIds).toHaveBeenCalledTimes(1);
    expect(page.items[0]).toMatchObject({ customerNickname: '客户甲', companyName: '甲公司' });
    expect(page.items[0]).not.toHaveProperty('customerAccountId');
  });

  it('空白筛选词与 requestNo 归一化透传：空白视为未提供', async () => {
    await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination(),
      filter: { requestNo: '   ', errorCode: ' E-001 ' },
    });

    const call = (adminRepairRequestQueryService.listAll as jest.Mock).mock.calls[0][0];
    expect(call.filter.requestNo).toBeUndefined();
    expect(call.filter.errorCode).toBe('E-001');
  });

  it('二级管理员唯一 SUPER_ADMIN 公司：列表与 total 共用同一可信公司，旧会话公司不覆盖', async () => {
    (accountQueryService.findAdminLevelByAccountId as jest.Mock).mockResolvedValue(2);
    (trustedOrganizationContext.resolveForAccount as jest.Mock).mockResolvedValue({
      organizationId: 700001,
      memberRole: IdentityTypeEnum.SUPER_ADMIN,
    });

    await usecase.execute({
      session: createSuperAdminSession({ adminLevel: 2, adminOrganizationId: 700099 }),
      pagination: offsetPagination(),
    });

    expect(adminRepairRequestQueryService.listAll).toHaveBeenCalledWith(
      expect.objectContaining({
        pagination: { page: 1, pageSize: 10, withTotal: true },
        organizationId: 700001,
      }),
    );
    expect(trustedOrganizationContext.resolveForAccount).toHaveBeenCalledWith({
      accountId: createSuperAdminSession().accountId,
    });
  });

  it('二级管理员只有 ENGINEER 成员关系：失败关闭，列表与 total 均不发起查询', async () => {
    (accountQueryService.findAdminLevelByAccountId as jest.Mock).mockResolvedValue(2);
    (trustedOrganizationContext.resolveForAccount as jest.Mock).mockResolvedValue({
      organizationId: 700001,
      memberRole: IdentityTypeEnum.ENGINEER,
    });

    const error = (await captureThrownError(
      usecase.execute({
        session: createSuperAdminSession({ adminLevel: 2, adminOrganizationId: 700001 }),
        pagination: offsetPagination(),
      }),
    )) as { code?: string };

    expect(error.code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
    expect(adminRepairRequestQueryService.listAll).not.toHaveBeenCalled();
  });
});
