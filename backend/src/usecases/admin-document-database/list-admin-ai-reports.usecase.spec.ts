// src/usecases/admin-document-database/list-admin-ai-reports.usecase.spec.ts

import type { OffsetParams, PaginationParams } from '@core/pagination/pagination.types';
import { PERMISSION_ERROR } from '@core/common/errors/domain-error';
import type {
  AdminAiReportListItemQueryResult,
  AdminAiReportListPage,
} from '@src/modules/lithography/admin-document-database.types';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { AdminAiReportQueryService } from '@src/modules/lithography/queries/admin-ai-report.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  captureThrownError,
  createSuperAdminSession,
  createUnauthorizedSessions,
} from '../../../test/support/account/admin-user.fixture';
import { ListAdminAiReportsUsecase } from './list-admin-ai-reports.usecase';

/**
 * PR3 S4：管理员全局 AI 报告列表用例单测（分支 × 时序矩阵）。
 *
 * 与会话/维修申请列表同构，但按报告特有语义补强：
 * - 精确授权先行（失败关闭时本域与账户域均不触发，要求 2）；
 * - 仅 OFFSET 分页、页大小钳制与 GraphQL @Max(100) 对齐；
 * - engineerKeyword 跨账户域解析（超限显式拒绝 / 无命中短路，M-02）；
 * - 列表不投影正文大字段，requestMismatch 审计标记原样透传（M-04）；
 * - 富集恰一次批量账户查询（防 N+1），剥离 engineerAccountId。
 */
describe('ListAdminAiReportsUsecase', () => {
  const offsetPagination = (overrides: Partial<OffsetParams> = {}): PaginationParams => ({
    mode: 'OFFSET' as const,
    page: 1,
    pageSize: 10,
    withTotal: true,
    ...overrides,
  });

  const makeListItem = (
    overrides: Partial<AdminAiReportListItemQueryResult> = {},
  ): AdminAiReportListItemQueryResult => ({
    id: 550001,
    requestId: 880001,
    requestNo: 'RR-20260901-001',
    requestMismatch: false,
    conversationId: 660001,
    engineerAccountId: 900002,
    reportTitle: '诊断报告',
    reportType: 'DIAGNOSIS',
    createdAt: new Date('2026-09-02T10:30:00.000Z'),
    ...overrides,
  });

  const makeListPage = (
    items: AdminAiReportListItemQueryResult[] = [makeListItem()],
  ): Omit<AdminAiReportListPage, 'items'> & { items: AdminAiReportListItemQueryResult[] } => ({
    items,
    total: items.length,
    page: 1,
    pageSize: 10,
  });

  const adminAiReportQueryService = {
    listAll: jest.fn().mockResolvedValue(makeListPage()),
  } as unknown as AdminAiReportQueryService;

  const accountQueryService = {
    findAdminLevelByAccountId: jest.fn().mockResolvedValue(1),
    findAccountIdsByDisplayKeyword: jest
      .fn()
      .mockResolvedValue({ accountIds: [], totalMatched: 0 }),
    findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map([[900002, '陈工程师']])),
  } as unknown as AccountQueryService;

  const organizationContextService = {
    resolveForAccount: jest.fn().mockResolvedValue({ organizationId: 12 }),
  } as unknown as TrustedOrganizationContextQueryService;

  const usecase = new ListAdminAiReportsUsecase(
    adminAiReportQueryService,
    accountQueryService,
    organizationContextService,
  );

  beforeEach(() => {
    (adminAiReportQueryService.listAll as jest.Mock).mockClear().mockResolvedValue(makeListPage());
    (accountQueryService.findAdminLevelByAccountId as jest.Mock).mockClear().mockResolvedValue(1);
    (accountQueryService.findAccountIdsByDisplayKeyword as jest.Mock)
      .mockClear()
      .mockResolvedValue({ accountIds: [], totalMatched: 0 });
    (accountQueryService.findNicknamesByAccountIds as jest.Mock)
      .mockClear()
      .mockResolvedValue(new Map([[900002, '陈工程师']]));
  });

  it.each(createUnauthorizedSessions().map(([label, session]) => ({ label, session })))(
    '$label 时授权先行拒绝，不触发本域与账户域任何查询',
    async ({ session }) => {
      const error = (await captureThrownError(
        usecase.execute({ session, pagination: offsetPagination() }),
      )) as { code?: string };

      expect(error.code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
      expect(adminAiReportQueryService.listAll).not.toHaveBeenCalled();
      expect(accountQueryService.findAccountIdsByDisplayKeyword).not.toHaveBeenCalled();
      expect(accountQueryService.findNicknamesByAccountIds).not.toHaveBeenCalled();
    },
  );

  it('非 OFFSET 分页拒绝（管理员聚合仅支持 OFFSET），不触发查询', async () => {
    const error = (await captureThrownError(
      usecase.execute({
        session: createSuperAdminSession(),
        pagination: { mode: 'CURSOR', limit: 10 } as unknown as PaginationParams,
      }),
    )) as { code?: string; message?: string };

    expect(error.message).toContain('仅支持 OFFSET 分页');
    expect(adminAiReportQueryService.listAll).not.toHaveBeenCalled();
  });

  it('页大小钳制与 GraphQL 边界 @Max(100) 对齐（超出收敛为 100）', async () => {
    await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination({ pageSize: 500 }),
    });

    const call = (adminAiReportQueryService.listAll as jest.Mock).mock.calls[0][0];
    expect(call.pagination.pageSize).toBe(100);
  });

  it('engineerKeyword 经账户域解析为账号 ID 集合后进 SQL 筛选并批量富集', async () => {
    (accountQueryService.findAccountIdsByDisplayKeyword as jest.Mock).mockResolvedValue({
      accountIds: [900002],
      totalMatched: 1,
    });

    const page = await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination(),
      filter: { engineerKeyword: '  陈  ' },
    });

    expect(accountQueryService.findAccountIdsByDisplayKeyword).toHaveBeenCalledWith('陈', 1000);
    const call = (adminAiReportQueryService.listAll as jest.Mock).mock.calls[0][0];
    expect(call.filter.engineerAccountIds).toEqual([900002]);
    expect(page.items[0]).toMatchObject({ engineerNickname: '陈工程师' });
    expect(page.items[0]).not.toHaveProperty('engineerAccountId');
  });

  it('engineerKeyword 无命中时短路返回空页，不发起本域查询', async () => {
    const page = await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination(),
      filter: { engineerKeyword: '不存在' },
    });

    expect(page).toMatchObject({ items: [], total: 0 });
    expect(adminAiReportQueryService.listAll).not.toHaveBeenCalled();
    expect(accountQueryService.findNicknamesByAccountIds).not.toHaveBeenCalled();
  });

  it('engineerKeyword 命中数超上限时显式拒绝（不静默截断漏数，M-02）', async () => {
    (accountQueryService.findAccountIdsByDisplayKeyword as jest.Mock).mockResolvedValue({
      accountIds: Array.from({ length: 1000 }, (_, i) => i + 1),
      totalMatched: 1001,
    });

    const error = (await captureThrownError(
      usecase.execute({
        session: createSuperAdminSession(),
        pagination: offsetPagination(),
        filter: { engineerKeyword: '超宽关键字' },
      }),
    )) as { code?: string; message?: string };

    expect(error.message).toContain('命中账号过多');
    expect(adminAiReportQueryService.listAll).not.toHaveBeenCalled();
  });

  it('一级管理员全范围，二级管理员按可信组织下推报告范围', async () => {
    await usecase.execute({ session: createSuperAdminSession(), pagination: offsetPagination() });
    const level1Call = (adminAiReportQueryService.listAll as jest.Mock).mock.calls[0][0];
    expect(level1Call.filter.ownerOrganizationId).toBeUndefined();

    (accountQueryService.findAdminLevelByAccountId as jest.Mock).mockResolvedValue(2);
    await usecase.execute({ session: createSuperAdminSession(), pagination: offsetPagination() });
    const level2Call = (adminAiReportQueryService.listAll as jest.Mock).mock.calls[1][0];
    expect(level2Call.filter.ownerOrganizationId).toBe(12);
  });

  it('时间范围非法（from 晚于 to）在查询前拒绝', async () => {
    const error = (await captureThrownError(
      usecase.execute({
        session: createSuperAdminSession(),
        pagination: offsetPagination(),
        filter: {
          createdAtFrom: new Date('2026-09-30'),
          createdAtTo: new Date('2026-09-01'),
        },
      }),
    )) as { code?: string };

    expect(error.code).toBe('ADMIN_DOCUMENT_DATABASE_INVALID_PARAMS');
    expect(adminAiReportQueryService.listAll).not.toHaveBeenCalled();
  });

  it('富集恰一次批量账户查询（防 N+1），多行工程师昵称一并取回', async () => {
    (adminAiReportQueryService.listAll as jest.Mock).mockResolvedValue(
      makeListPage([
        makeListItem({ id: 550001, engineerAccountId: 900002 }),
        makeListItem({ id: 550002, engineerAccountId: 900003 }),
      ]),
    );
    (accountQueryService.findNicknamesByAccountIds as jest.Mock).mockResolvedValue(
      new Map<number, string>([
        [900002, '陈工程师'],
        [900003, '王工程师'],
      ]),
    );

    const page = await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination(),
    });

    expect(accountQueryService.findNicknamesByAccountIds).toHaveBeenCalledTimes(1);
    expect(accountQueryService.findNicknamesByAccountIds).toHaveBeenCalledWith([900002, 900003]);
    expect(page.items.map((item) => item.engineerNickname)).toEqual(['陈工程师', '王工程师']);
  });

  it('requestMismatch 审计标记原样透传（M-04：异常历史数据不静默改写）', async () => {
    (adminAiReportQueryService.listAll as jest.Mock).mockResolvedValue(
      makeListPage([makeListItem({ requestMismatch: true })]),
    );

    const page = await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination(),
    });

    expect(page.items[0]).toMatchObject({ requestMismatch: true });
  });

  it('空白筛选词归一化透传：requestNo/reportType 空白视为未提供', async () => {
    await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination(),
      filter: { requestNo: '   ', reportType: ' DIAGNOSIS ' },
    });

    const call = (adminAiReportQueryService.listAll as jest.Mock).mock.calls[0][0];
    expect(call.filter.requestNo).toBeUndefined();
    expect(call.filter.reportType).toBe('DIAGNOSIS');
  });

  it('无 engineerKeyword 时不查账户域关键字解析，engineerAccountIds 保持 undefined', async () => {
    await usecase.execute({
      session: createSuperAdminSession(),
      pagination: offsetPagination(),
      filter: { requestNo: 'RR-20260901-001' },
    });

    expect(accountQueryService.findAccountIdsByDisplayKeyword).not.toHaveBeenCalled();
    const call = (adminAiReportQueryService.listAll as jest.Mock).mock.calls[0][0];
    expect(call.filter.engineerAccountIds).toBeUndefined();
  });
});
