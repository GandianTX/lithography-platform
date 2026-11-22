// src/usecases/maintenance-report/get-my-maintenance-report.usecase.spec.ts
// 任务 07 我的资料记录详情访问边界定向测试（R052 / 页面 V6.5 §9.2；2026-11-21 设计确认）：
// 页面只展示本人创建记录——所有状态要求作者本人 + 本组织资源授权；
// 他人草稿/他人待审/他人正式记录统一 NOT_FOUND；越权 ID 一律拒绝；
// 列表与详情使用同一服务端授权口径（读入口断言 + 归属谓词）。

/// <reference types="jest" />

import type { UsecaseSession } from '@app-types/auth/session.types';
import { MAINTENANCE_REPORT_ERROR, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { MaintenanceReportSyncStatusReader } from './ports/maintenance-report-sync-status-reader.contract';
import { GetMyMaintenanceReportUsecase } from './get-my-maintenance-report.usecase';

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

/** 一级管理员：平台级角色，业务上没有所属公司（测试数据不虚构成员关系） */
const firstLevelAdminSession = {
  accountId: 900090,
  roles: ['SUPER_ADMIN'],
  activeRole: 'SUPER_ADMIN',
} as unknown as UsecaseSession;

const customerSession = {
  accountId: 900777,
  roles: ['CUSTOMER'],
  activeRole: 'CUSTOMER',
} as unknown as UsecaseSession;

const makeUsecase = (
  params: {
    ownership?: {
      maintenanceEngineerAccountId: number;
      ownerOrganizationId: number;
      status: string;
    } | null;
    detail?: Record<string, unknown> | null;
    syncStatuses?: unknown;
    syncStatusReader?: MaintenanceReportSyncStatusReader & { fetchStatuses: jest.Mock };
  } = {},
) => {
  const queryService = {
    readReportOwnership: jest.fn().mockResolvedValue(
      params.ownership === undefined
        ? {
            maintenanceEngineerAccountId: 900099,
            ownerOrganizationId: ORG_ID,
            status: 'APPROVED',
          }
        : params.ownership,
    ),
    readReportDetail: jest.fn().mockResolvedValue(
      params.detail === undefined
        ? {
            report: {
              id: 960101,
              sourceType: 'HISTORICAL_CASE',
              status: 'APPROVED',
              title: '管理员本人正式记录',
              maintenanceEngineerAccountId: 900099,
              updatedAt: new Date('2026-11-01T00:00:00.000Z'),
            },
            alarms: [],
            steps: [],
            currentAttachments: [],
            latestReturnComment: null,
            currentVersion: null,
            currentVersionAttachments: [],
            currentReview: null,
            reviewHistory: [],
            canEdit: false,
          }
        : params.detail,
    ),
  };
  const referenceDocumentQueryService = {
    listPublishedDocumentIdsByReportIds: jest.fn().mockResolvedValue(new Map()),
  };
  const equipmentModelQueryService = { findModelById: jest.fn().mockResolvedValue(null) };
  const organizationContextService = {
    resolveForAccount: jest.fn().mockResolvedValue({ organizationId: ORG_ID, memberRole: 'ADMIN' }),
  };
  // 账号等级事实替身：缺省 null（未映射等级，按本公司口径），一级用例覆写为 1。
  // 一级管理员测试数据不构造成员关系——resolveForAccount 若被调用即证明违反平台级口径。
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
    organizationContextService,
    accountQueryService,
    syncStatusReader,
    usecase: new GetMyMaintenanceReportUsecase(
      queryService as unknown as MaintenanceReportQueryService,
      referenceDocumentQueryService as unknown as ReferenceDocumentQueryService,
      equipmentModelQueryService as unknown as EquipmentModelQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      accountQueryService as unknown as AccountQueryService,
      syncStatusReader,
    ),
  };
};

describe('GetMyMaintenanceReportUsecase（我的资料记录详情 · 管理员访问边界）', () => {
  it('管理员读取本人名下正式记录：可读，详情谓词 = 作者 + 本组织（授权不依赖第一次检查）', async () => {
    const { usecase, queryService } = makeUsecase();

    const result = await usecase.execute({ session: adminSession, reportId: 960101 });

    expect(result.report.id).toBe(960101);
    expect(queryService.readReportDetail).toHaveBeenCalledWith(960101, undefined, {
      ownerOrganizationId: ORG_ID,
      maintenanceEngineerAccountId: 900099,
    });
  });

  it('管理员读取本公司他人正式记录：NOT_FOUND（页面只展示本人创建记录，他人正式走资料库/文档数据库）', async () => {
    const { usecase, queryService } = makeUsecase({
      ownership: {
        maintenanceEngineerAccountId: 900001,
        ownerOrganizationId: ORG_ID,
        status: 'APPROVED',
      },
    });

    await expect(
      usecase.execute({ session: adminSession, reportId: 960105 }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });
    expect(queryService.readReportDetail).not.toHaveBeenCalled();
  });

  it('工程师读取本人正式记录：可读，范围谓词含作者（本人正式记录仍受本组织资源授权）', async () => {
    const { usecase, queryService } = makeUsecase({
      ownership: {
        maintenanceEngineerAccountId: 900001,
        ownerOrganizationId: ORG_ID,
        status: 'APPROVED',
      },
      detail: {
        report: {
          id: 960105,
          sourceType: 'HISTORICAL_CASE',
          status: 'APPROVED',
          title: '工程师本人正式记录',
          maintenanceEngineerAccountId: 900001,
          equipmentModelId: null,
          updatedAt: new Date('2026-11-01T00:00:00.000Z'),
        },
        alarms: [],
        steps: [],
        currentAttachments: [],
        latestReturnComment: null,
        currentVersion: null,
        currentVersionAttachments: [],
        currentReview: null,
        reviewHistory: [],
        canEdit: false,
      },
    });

    const result = await usecase.execute({ session: engineerSession, reportId: 960105 });

    expect(result.report.id).toBe(960105);
    expect(queryService.readReportDetail).toHaveBeenCalledWith(960105, undefined, {
      ownerOrganizationId: ORG_ID,
      maintenanceEngineerAccountId: 900001,
    });
  });

  it('工程师读取本公司他人正式记录：同样 NOT_FOUND（不因同公司放行他人记录）', async () => {
    const { usecase } = makeUsecase({
      ownership: {
        maintenanceEngineerAccountId: 900099,
        ownerOrganizationId: ORG_ID,
        status: 'APPROVED',
      },
    });

    await expect(
      usecase.execute({ session: engineerSession, reportId: 960108 }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });
  });

  it('一级管理员读取本人名下正式记录（归属任意公司）：可读，不解析组织成员关系，谓词仅作者', async () => {
    const { usecase, queryService, organizationContextService, accountQueryService } = makeUsecase({
      ownership: {
        maintenanceEngineerAccountId: 900090,
        ownerOrganizationId: 920001,
        status: 'APPROVED',
      },
      detail: {
        report: {
          id: 960110,
          sourceType: 'HISTORICAL_CASE',
          status: 'APPROVED',
          title: '一级管理员本人正式记录（原归属公司）',
          maintenanceEngineerAccountId: 900090,
          equipmentModelId: null,
          updatedAt: new Date('2026-11-01T00:00:00.000Z'),
        },
        alarms: [],
        steps: [],
        currentAttachments: [],
        latestReturnComment: null,
        currentVersion: null,
        currentVersionAttachments: [],
        currentReview: null,
        reviewHistory: [],
        canEdit: false,
      },
    });
    accountQueryService.findAdminLevelByAccountId.mockResolvedValue(1);

    const result = await usecase.execute({ session: firstLevelAdminSession, reportId: 960110 });

    expect(result.report.id).toBe(960110);
    expect(accountQueryService.findAdminLevelByAccountId).toHaveBeenCalledWith(900090);
    // 平台级角色不读取成员事实：技术上存在的成员关系行不是业务所属公司，不作权限条件
    expect(organizationContextService.resolveForAccount).not.toHaveBeenCalled();
    expect(queryService.readReportDetail).toHaveBeenCalledWith(960110, undefined, {
      maintenanceEngineerAccountId: 900090,
    });
  });

  it('一级管理员读取他人正式记录：NOT_FOUND（页面只展示本人创建记录，他人记录走资料库/文档数据库）', async () => {
    const { usecase, queryService, accountQueryService } = makeUsecase({
      ownership: {
        maintenanceEngineerAccountId: 900001,
        ownerOrganizationId: ORG_ID,
        status: 'APPROVED',
      },
    });
    accountQueryService.findAdminLevelByAccountId.mockResolvedValue(1);

    await expect(
      usecase.execute({ session: firstLevelAdminSession, reportId: 960105 }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });
    expect(queryService.readReportDetail).not.toHaveBeenCalled();
  });

  it('一级管理员读取他人草稿：同样 NOT_FOUND（平台级口径不放开他人私稿）', async () => {
    const { usecase, accountQueryService } = makeUsecase({
      ownership: {
        maintenanceEngineerAccountId: 900001,
        ownerOrganizationId: ORG_ID,
        status: 'DRAFT',
      },
    });
    accountQueryService.findAdminLevelByAccountId.mockResolvedValue(1);

    await expect(
      usecase.execute({ session: firstLevelAdminSession, reportId: 960004 }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });
  });

  it('二级管理员（admin_level=2）维持作者+本公司谓词：本人正式记录谓词含公司，不因一级规则放宽', async () => {
    const { usecase, queryService, accountQueryService } = makeUsecase();
    accountQueryService.findAdminLevelByAccountId.mockResolvedValue(2);

    const result = await usecase.execute({ session: adminSession, reportId: 960101 });

    expect(result.report.id).toBe(960101);
    expect(queryService.readReportDetail).toHaveBeenCalledWith(960101, undefined, {
      ownerOrganizationId: ORG_ID,
      maintenanceEngineerAccountId: 900099,
    });
  });

  it('本人待审记录（历史流程）仍可读：未完成态按作者本人收敛，范围谓词含作者', async () => {
    const { usecase, queryService } = makeUsecase({
      ownership: {
        maintenanceEngineerAccountId: 900099,
        ownerOrganizationId: ORG_ID,
        status: 'PENDING_REVIEW',
      },
    });

    await expect(
      usecase.execute({ session: adminSession, reportId: 960106 }),
    ).resolves.toBeDefined();
    expect(queryService.readReportDetail).toHaveBeenCalledWith(960106, undefined, {
      ownerOrganizationId: ORG_ID,
      maintenanceEngineerAccountId: 900099,
    });
  });

  it('管理员读取本公司他人待审记录：统一 NOT_FOUND（待审不属于「本来允许读取的正式记录」）', async () => {
    const { usecase } = makeUsecase({
      ownership: {
        maintenanceEngineerAccountId: 900001,
        ownerOrganizationId: ORG_ID,
        status: 'PENDING_REVIEW',
      },
    });

    await expect(
      usecase.execute({ session: adminSession, reportId: 960107 }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });
  });

  it('管理员读取他人草稿：归属谓词拒绝，统一 NOT_FOUND（不泄露存在性，不因管理员角色放行）', async () => {
    const { usecase } = makeUsecase({
      ownership: {
        maintenanceEngineerAccountId: 900001,
        ownerOrganizationId: ORG_ID,
        status: 'DRAFT',
      },
    });

    await expect(
      usecase.execute({ session: adminSession, reportId: 960002 }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });
  });

  it('工程师读取他人草稿：同样 NOT_FOUND（边界不因角色放宽到他人私稿）', async () => {
    const { usecase } = makeUsecase({
      ownership: {
        maintenanceEngineerAccountId: 900099,
        ownerOrganizationId: ORG_ID,
        status: 'DRAFT',
      },
    });

    await expect(
      usecase.execute({ session: engineerSession, reportId: 960003 }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });
  });

  it('越权 ID 负例：不存在 / 跨组织 / 归属缺失（null）一律 NOT_FOUND，不触达详情读', async () => {
    const notFound = makeUsecase({ ownership: null });
    await expect(
      notFound.usecase.execute({ session: adminSession, reportId: 999999 }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });

    const crossOrg = makeUsecase({
      ownership: {
        maintenanceEngineerAccountId: 900099,
        ownerOrganizationId: 920001,
        status: 'APPROVED',
      },
    });
    // 作者换公司场景同口径：本人名下记录但归属他组织 → 资源授权（本组织谓词）拒绝，
    // 不自动转移历史记录归属，也不因曾是作者绕过权限
    await expect(
      crossOrg.usecase.execute({ session: adminSession, reportId: 960101 }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });
    expect(crossOrg.queryService.readReportDetail).not.toHaveBeenCalled();
  });

  it('双重归属谓词不一致（锁外核验通过但谓词读不命中）仍 NOT_FOUND：列表/total/详情同一授权', async () => {
    const { usecase } = makeUsecase({ detail: null });

    await expect(
      usecase.execute({ session: adminSession, reportId: 960101 }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });
  });

  it('客户直连拒绝且不解析组织（守卫兜底之后的 usecase 防线）', async () => {
    const { usecase, organizationContextService } = makeUsecase();

    await expect(
      usecase.execute({ session: customerSession, reportId: 960101 }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(organizationContextService.resolveForAccount).not.toHaveBeenCalled();
  });

  it('reportId 非法（非正整数）拒绝：INVALID_PARAMS', async () => {
    const { usecase } = makeUsecase();

    await expect(usecase.execute({ session: adminSession, reportId: 0 })).rejects.toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.INVALID_PARAMS,
    });
  });

  it('同步状态预留：详情复用列表同一批量接口（单条一批），默认装配展示 NOT_CONNECTED', async () => {
    const { usecase, syncStatusReader } = makeUsecase();

    const result = await usecase.execute({ session: adminSession, reportId: 960101 });

    expect(result.syncStatus).toMatchObject({
      status: 'NOT_CONNECTED',
      conflictId: null,
      canResolveConflict: false,
    });
    expect(syncStatusReader.fetchStatuses).toHaveBeenCalledTimes(1);
    // 跨端 UUID 待任务 09 对齐：映射缺失不发真实查询键（空批量用于区分装配状态）
    expect(syncStatusReader.fetchStatuses).toHaveBeenCalledWith([]);
  });

  it('同步状态预留：授权失败时适配层不被调用（无权记录不进入同步查询）', async () => {
    // 默认归属为管理员本人（900099）；工程师（900001）非作者，页面口径统一 NOT_FOUND
    const { usecase, syncStatusReader } = makeUsecase();

    await expect(
      usecase.execute({ session: engineerSession, reportId: 960101 }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });
    expect(syncStatusReader.fetchStatuses).not.toHaveBeenCalled();
  });

  it('同步状态预留：提供方失败降级 UNKNOWN，详情本体不受影响', async () => {
    const syncStatusReader = {
      fetchStatuses: jest.fn().mockRejectedValue(new Error('sync provider unavailable')),
    } as unknown as MaintenanceReportSyncStatusReader & { fetchStatuses: jest.Mock };
    const { usecase } = makeUsecase({ syncStatusReader });

    const result = await usecase.execute({ session: adminSession, reportId: 960101 });

    expect(result.report.id).toBe(960101);
    expect(result.syncStatus).toMatchObject({ status: 'UNKNOWN' });
  });
});
