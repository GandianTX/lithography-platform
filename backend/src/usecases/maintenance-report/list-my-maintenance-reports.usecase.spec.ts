// src/usecases/maintenance-report/list-my-maintenance-reports.usecase.spec.ts
// 任务 07 我的资料记录定向测试：分页 total / 筛选 / 成品入口 / 角色与直连兜底。

/// <reference types="jest" />

import type { UsecaseSession } from '@app-types/auth/session.types';
import { MAINTENANCE_REPORT_ERROR, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { MaintenanceReportSyncStatusReader } from './ports/maintenance-report-sync-status-reader.contract';
import { ListMyMaintenanceReportsUsecase } from './list-my-maintenance-reports.usecase';

const ORG_ID = 910001;

const engineerSession = {
  accountId: 900001,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as unknown as UsecaseSession;

const adminSession = {
  accountId: 900099,
  roles: ['SUPER_ADMIN', 'ENGINEER'],
  activeRole: 'SUPER_ADMIN',
} as unknown as UsecaseSession;

const customerSession = {
  accountId: 900777,
  roles: ['CUSTOMER'],
  activeRole: 'CUSTOMER',
} as unknown as UsecaseSession;

/** 一级管理员：平台级角色，业务上没有所属公司（测试数据不虚构成员关系） */
const firstLevelAdminSession = {
  accountId: 900090,
  roles: ['SUPER_ADMIN'],
  activeRole: 'SUPER_ADMIN',
} as unknown as UsecaseSession;

const makeSummary = (overrides: Record<string, unknown> = {}) => ({
  id: 960001,
  ownerOrganizationId: ORG_ID,
  sourceType: 'HISTORICAL_CASE',
  repairRequestId: null,
  title: '光刻机报警处理经验',
  status: 'DRAFT',
  currentVersionNo: 0,
  maintenanceDate: null,
  updatedAt: new Date('2026-11-01T00:00:00.000Z'),
  ...overrides,
});

const makeUsecase = (
  params: {
    page?: {
      items: ReturnType<typeof makeSummary>[];
      total?: number;
      page: number;
      pageSize: number;
    };
    published?: Map<number, number>;
    syncStatuses?: unknown;
    syncStatusReader?: MaintenanceReportSyncStatusReader & { fetchStatuses: jest.Mock };
  } = {},
) => {
  const queryService = {
    listMine: jest.fn().mockResolvedValue(
      params.page ?? {
        items: [makeSummary({ id: 960001 }), makeSummary({ id: 960002, status: 'APPROVED' })],
        total: 12,
        page: 1,
        pageSize: 10,
      },
    ),
  };
  const referenceDocumentQueryService = {
    listPublishedDocumentIdsByReportIds: jest
      .fn()
      .mockResolvedValue(params.published ?? new Map([[960002, 970001]])),
  };
  const organizationContextService = {
    resolveForAccount: jest
      .fn()
      .mockResolvedValue({ organizationId: ORG_ID, memberRole: 'ENGINEER' }),
  };
  // 账号等级事实替身：缺省 null（未映射等级），一级用例覆写为 1。
  // 一级管理员测试数据不构造成员关系行——resolveForAccount 若被调用会抛错，从而
  // 证明平台级角色读取不依赖业务公司。
  const accountQueryService = {
    findAdminLevelByAccountId: jest.fn().mockResolvedValue(null),
  };
  // 同步状态替身（任务 07 预留）：缺省=未装配默认适配（connected=false、零条目）。
  const syncStatusReader = params.syncStatusReader ?? {
    fetchStatuses: jest
      .fn()
      .mockResolvedValue(params.syncStatuses ?? { connected: false, entries: [] }),
  };
  return {
    queryService,
    referenceDocumentQueryService,
    organizationContextService,
    accountQueryService,
    syncStatusReader,
    usecase: new ListMyMaintenanceReportsUsecase(
      queryService as unknown as MaintenanceReportQueryService,
      referenceDocumentQueryService as unknown as ReferenceDocumentQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      accountQueryService as unknown as AccountQueryService,
      syncStatusReader,
    ),
  };
};

describe('ListMyMaintenanceReportsUsecase（我的资料记录）', () => {
  it('本人范围 + 分页 total 透传：total 与列表同一归属谓词', async () => {
    const { usecase, queryService, organizationContextService } = makeUsecase();

    const result = await usecase.execute({
      session: engineerSession,
      pagination: { page: 1, pageSize: 10, withTotal: true },
    });

    expect(organizationContextService.resolveForAccount).toHaveBeenCalledWith({
      accountId: 900001,
    });
    expect(queryService.listMine).toHaveBeenCalledWith(
      900001,
      ORG_ID,
      expect.objectContaining({ page: 1, pageSize: 10, withTotal: true }),
      {},
    );
    expect(result.total).toBe(12);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(10);
  });

  it('未完成 / 已提交筛选原样下推到查询层，不硬编码正式状态', async () => {
    const { usecase, queryService } = makeUsecase();

    await usecase.execute({
      session: engineerSession,
      pagination: { page: 1, pageSize: 10 },
      filter: { recordKind: 'DRAFT', sourceType: 'WORK_ORDER_SUMMARY' },
    });

    expect(queryService.listMine).toHaveBeenCalledWith(900001, ORG_ID, expect.anything(), {
      recordKind: 'DRAFT',
      sourceType: 'WORK_ORDER_SUMMARY',
    });
  });

  it('标题关键词归一化后下推：trim 生效、空白等价未提供、超长拒绝且不进入查询', async () => {
    const { usecase, queryService } = makeUsecase();

    await usecase.execute({
      session: engineerSession,
      pagination: { page: 1, pageSize: 10 },
      filter: { titleKeyword: '  光刻机报警  ' },
    });
    expect(queryService.listMine).toHaveBeenLastCalledWith(900001, ORG_ID, expect.anything(), {
      titleKeyword: '光刻机报警',
    });

    await usecase.execute({
      session: engineerSession,
      pagination: { page: 1, pageSize: 10 },
      filter: { titleKeyword: '   ' },
    });
    expect(queryService.listMine).toHaveBeenLastCalledWith(900001, ORG_ID, expect.anything(), {});

    await expect(
      usecase.execute({
        session: engineerSession,
        pagination: { page: 1, pageSize: 10 },
        filter: { titleKeyword: '光'.repeat(101) },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS });
    expect(queryService.listMine).toHaveBeenCalledTimes(2);
  });

  it('已发布资料返回成品标识；未发布/已下架为空（批量一次查询）', async () => {
    const { usecase, referenceDocumentQueryService } = makeUsecase();

    const result = await usecase.execute({ session: engineerSession });

    expect(referenceDocumentQueryService.listPublishedDocumentIdsByReportIds).toHaveBeenCalledWith(
      [960001, 960002],
      ORG_ID,
    );
    expect(result.items.find((item) => item.id === 960001)?.publishedDocumentId).toBeNull();
    expect(result.items.find((item) => item.id === 960002)?.publishedDocumentId).toBe(970001);
  });

  it('空列表不触发成品标识批量查询', async () => {
    const { usecase, referenceDocumentQueryService } = makeUsecase({
      page: { items: [], total: 0, page: 1, pageSize: 10 },
    });

    const result = await usecase.execute({ session: engineerSession });

    expect(result.items).toEqual([]);
    expect(
      referenceDocumentQueryService.listPublishedDocumentIdsByReportIds,
    ).not.toHaveBeenCalled();
  });

  it('筛选值非法：INVALID_PARAMS，不进入任何查询', async () => {
    const { usecase, queryService } = makeUsecase();

    await expect(
      usecase.execute({
        session: engineerSession,
        filter: { recordKind: 'PUBLISHED' as never },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS });
    expect(queryService.listMine).not.toHaveBeenCalled();
  });

  it('CURSOR 分页明确拒绝，不静默降级为 OFFSET', async () => {
    const { usecase, queryService } = makeUsecase();

    await expect(
      usecase.execute({
        session: engineerSession,
        pagination: { mode: 'CURSOR', page: 1, pageSize: 10 },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS });
    expect(queryService.listMine).not.toHaveBeenCalled();
  });

  it('一级管理员（平台级角色、无业务所属公司）正常进入：不解析组织成员关系，列表/成品标识只按作者谓词', async () => {
    const {
      usecase,
      queryService,
      referenceDocumentQueryService,
      organizationContextService,
      accountQueryService,
    } = makeUsecase();
    accountQueryService.findAdminLevelByAccountId.mockResolvedValue(1);

    await usecase.execute({ session: firstLevelAdminSession });

    // 平台级角色不读取成员事实：即使测试替身被调用会给出公司，也不得当作权限条件
    expect(accountQueryService.findAdminLevelByAccountId).toHaveBeenCalledWith(900090);
    expect(organizationContextService.resolveForAccount).not.toHaveBeenCalled();
    expect(queryService.listMine).toHaveBeenCalledWith(
      900090,
      undefined,
      expect.anything(),
      expect.anything(),
    );
    // 成品标识不按公司过滤（资料侧由一级 GLOBAL 权限在详情读侧裁决）
    expect(referenceDocumentQueryService.listPublishedDocumentIdsByReportIds).toHaveBeenCalledWith(
      [960001, 960002],
      undefined,
    );
  });

  it('一级管理员没有本人记录：空列表/total=0 正常返回（不是组织错误、不放行他人记录）', async () => {
    const { usecase, organizationContextService, accountQueryService } = makeUsecase({
      page: { items: [], total: 0, page: 1, pageSize: 10 },
    });
    accountQueryService.findAdminLevelByAccountId.mockResolvedValue(1);

    const result = await usecase.execute({ session: firstLevelAdminSession });

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(organizationContextService.resolveForAccount).not.toHaveBeenCalled();
  });

  it('二级管理员（admin_level=2）与缺等级管理员维持作者+本公司谓词，不因一级规则放宽', async () => {
    const { usecase, queryService, organizationContextService, accountQueryService } =
      makeUsecase();
    accountQueryService.findAdminLevelByAccountId.mockResolvedValue(2);
    // 二级管理员按成员事实解析本公司（公司谓词保留），与一级平台级口径不同
    await usecase.execute({ session: adminSession });
    expect(organizationContextService.resolveForAccount).toHaveBeenCalledWith({
      accountId: adminSession.accountId,
    });
    expect(queryService.listMine).toHaveBeenCalledWith(
      adminSession.accountId,
      ORG_ID,
      expect.anything(),
      expect.anything(),
    );
  });

  it('管理员可进入本人记录入口（R052）：列表按「本人创建 + 本组织资源授权」谓词收敛，不读取他人记录', async () => {
    const { usecase, queryService, organizationContextService } = makeUsecase();

    // R052（2026-11-21 页面口径）：管理员保留本人记录查询（无新建入口）；他人草稿、
    // 他人待审与他人正式记录不出现在本页面，由查询谓词实现，不在角色层被拒
    await expect(usecase.execute({ session: adminSession })).resolves.toMatchObject({
      page: 1,
      pageSize: 10,
    });
    expect(organizationContextService.resolveForAccount).toHaveBeenCalledWith({
      accountId: adminSession.accountId,
    });
    expect(queryService.listMine).toHaveBeenCalledWith(
      adminSession.accountId,
      ORG_ID,
      expect.anything(),
      expect.anything(),
    );
  });

  it('管理员没有本人记录：空列表/total=0 正常返回（页面展示「暂无记录」，不报错、不放行他人记录）', async () => {
    const { usecase } = makeUsecase({
      page: { items: [], total: 0, page: 1, pageSize: 10 },
    });

    const result = await usecase.execute({ session: adminSession });

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('同步状态预留：默认装配展示 NOT_CONNECTED，一页多条记录只批量调用一次，无可信映射不发真实查询键', async () => {
    const { usecase, syncStatusReader } = makeUsecase();

    const result = await usecase.execute({ session: engineerSession });

    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      expect(item.syncStatus).toMatchObject({
        status: 'NOT_CONNECTED',
        message: null,
        conflictId: null,
        canResolveConflict: false,
      });
    }
    expect(syncStatusReader.fetchStatuses).toHaveBeenCalledTimes(1);
    // 跨端 UUID 待任务 09 对齐：映射缺失，不发真实查询键（空批量用于区分装配状态）
    expect(syncStatusReader.fetchStatuses).toHaveBeenCalledWith([]);
  });

  it('同步状态预留：已装配但映射缺失展示 UNKNOWN，不显示已同步', async () => {
    const { usecase } = makeUsecase({
      syncStatuses: { connected: true, entries: [] },
    });

    const result = await usecase.execute({ session: engineerSession });

    expect(result.items.every((item) => item.syncStatus.status === 'UNKNOWN')).toBe(true);
  });

  it('同步状态预留：提供方失败降级 UNKNOWN，原列表与 total 不受影响', async () => {
    const syncStatusReader = {
      fetchStatuses: jest.fn().mockRejectedValue(new Error('sync provider unavailable')),
    } as unknown as MaintenanceReportSyncStatusReader & { fetchStatuses: jest.Mock };
    const { usecase } = makeUsecase({ syncStatusReader });

    const result = await usecase.execute({ session: engineerSession });

    expect(result.total).toBe(12);
    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.syncStatus.status === 'UNKNOWN')).toBe(true);
  });

  it('空列表不触发同步状态批量调用', async () => {
    const { usecase, syncStatusReader } = makeUsecase({
      page: { items: [], total: 0, page: 1, pageSize: 10 },
    });

    await usecase.execute({ session: engineerSession });

    expect(syncStatusReader.fetchStatuses).not.toHaveBeenCalled();
  });

  it('客户直连：拒绝且不解析组织，无权记录不会传给同步状态适配层', async () => {
    const { usecase, organizationContextService, syncStatusReader } = makeUsecase();

    await expect(usecase.execute({ session: customerSession })).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
    expect(organizationContextService.resolveForAccount).not.toHaveBeenCalled();
    expect(syncStatusReader.fetchStatuses).not.toHaveBeenCalled();
  });
});
