// src/usecases/admin-document-database/list-admin-repair-requests.usecase.spec.ts

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
    findAccountIdsByDisplayKeyword: jest
      .fn()
      .mockResolvedValue({ accountIds: [], totalMatched: 0 }),
    findAccountDisplayInfosByAccountIds: jest.fn().mockResolvedValue(new Map()),
    findAdminLevelByAccountId: jest.fn().mockResolvedValue(1),
  } as unknown as AccountQueryService;

  const organizationContextService = {
    resolveForAccount: jest.fn().mockResolvedValue({ organizationId: 42 }),
  } as unknown as TrustedOrganizationContextQueryService;

  const usecase = new ListAdminRepairRequestsUsecase(
    adminRepairRequestQueryService,
    accountQueryService,
    organizationContextService,
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
    (organizationContextService.resolveForAccount as jest.Mock)
      .mockClear()
      .mockResolvedValue({ organizationId: 42 });
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

  it('一级管理员保留全平台范围：不向查询层传组织过滤', async () => {
    await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination(),
    });

    const call = (adminRepairRequestQueryService.listAll as jest.Mock).mock.calls[0][0];
    expect(call.filter.ownerOrganizationId).toBeUndefined();
  });

  it('二级管理员按可信成员组织收敛，前端筛选不能扩大范围', async () => {
    (accountQueryService.findAdminLevelByAccountId as jest.Mock).mockResolvedValue(2);

    await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination(),
      filter: { requestNo: 'RR-1' },
    });

    const call = (adminRepairRequestQueryService.listAll as jest.Mock).mock.calls[0][0];
    expect(call.filter.ownerOrganizationId).toBe(42);
    expect(call.filter).not.toHaveProperty('organizationId');
  });

  it('等级缺失不会提升为一级：仍按可信成员组织收敛', async () => {
    (accountQueryService.findAdminLevelByAccountId as jest.Mock).mockResolvedValue(null);

    await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination(),
    });

    const call = (adminRepairRequestQueryService.listAll as jest.Mock).mock.calls[0][0];
    expect(call.filter.ownerOrganizationId).toBe(42);
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
});
