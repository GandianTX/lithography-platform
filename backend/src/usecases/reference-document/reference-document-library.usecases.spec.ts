// src/usecases/reference-document/reference-document-library.usecases.spec.ts
// 任务 07 参考资料库读侧定向测试：范围 / 生效版本 / 无附件 / 下架删除 / 历史版本 / 下载。

/// <reference types="jest" />

import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  DomainError,
  PERMISSION_ERROR,
  REFERENCE_DOCUMENT_ERROR,
} from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { GetReferenceDocumentDetailUsecase } from './get-reference-document-detail.usecase';
import { GetReferenceDocumentFileUsecase } from './get-reference-document-file.usecase';
import { ListReferenceDocumentRevisionsUsecase } from './list-reference-document-revisions.usecase';
import type { ReferenceDocumentStorage } from './reference-document.types';

const ORG_ID = 910001;
const DOCUMENT_ID = 970001;
const REPORT_ID = 960001;
const VERSION_ID = 990001;

const engineerSession = {
  accountId: 900001,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as unknown as UsecaseSession;

const levelOneAdminSession = {
  accountId: 900099,
  roles: ['SUPER_ADMIN'],
  activeRole: 'SUPER_ADMIN',
} as unknown as UsecaseSession;

const levelTwoAdminSession = {
  accountId: 900098,
  roles: ['SUPER_ADMIN'],
  activeRole: 'SUPER_ADMIN',
} as unknown as UsecaseSession;

const customerSession = {
  accountId: 900777,
  roles: ['CUSTOMER'],
  activeRole: 'CUSTOMER',
} as unknown as UsecaseSession;

const makeDetail = (overrides: Record<string, unknown> = {}) =>
  ({
    id: DOCUMENT_ID,
    title: '光刻机报警处理经验',
    documentType: 'EXPERIENCE',
    equipmentModelId: null,
    equipmentModelName: null,
    equipmentModelText: null,
    description: null,
    contentText: '处理经过与结论',
    originalFilename: null,
    mimeType: null,
    fileSize: null,
    hasFile: false,
    storageReference: null,
    organizationName: '甲方默认组织',
    ingestMethod: 'ADMIN_DIRECT',
    sourceKind: 'MATERIAL',
    sourceReportId: null,
    sourceReportVersionId: null,
    publicationStatus: 'ONLINE',
    ownershipStatus: 'CONFIRMED',
    effectiveRevisionNo: 0,
    caseDetail: null,
    createdByAccountId: 900001,
    creatorNickname: '工程师甲',
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-02T00:00:00.000Z'),
    ...overrides,
  }) as never;

const makeQueryService = () => ({
  findDetail: jest.fn().mockResolvedValue(makeDetail()),
  findRevision: jest.fn().mockResolvedValue(null),
  listRevisions: jest.fn().mockResolvedValue([]),
  isStorageReferenceReferenced: jest.fn().mockResolvedValue(false),
});

const makeMaintenanceReportQueryService = () => ({
  readVersionById: jest.fn().mockResolvedValue(null),
});

const makeAccountQueryService = (adminLevel: number | null = null) => ({
  findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map([[900001, '工程师甲']])),
  findAdminLevelByAccountId: jest.fn().mockResolvedValue(adminLevel),
});

const makeOrganizationContextService = () => ({
  resolveForAccount: jest.fn().mockResolvedValue({ organizationId: ORG_ID, memberRole: 'ADMIN' }),
});

const notFound = { code: REFERENCE_DOCUMENT_ERROR.NOT_FOUND };

const makeDetailUsecase = (
  params: {
    queryService?: ReturnType<typeof makeQueryService>;
    maintenanceReportQueryService?: ReturnType<typeof makeMaintenanceReportQueryService>;
    accountQueryService?: ReturnType<typeof makeAccountQueryService>;
    organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
  } = {},
) => {
  const queryService = params.queryService ?? makeQueryService();
  const maintenanceReportQueryService =
    params.maintenanceReportQueryService ?? makeMaintenanceReportQueryService();
  const accountQueryService = params.accountQueryService ?? makeAccountQueryService();
  const organizationContextService =
    params.organizationContextService ?? makeOrganizationContextService();
  return {
    queryService,
    maintenanceReportQueryService,
    usecase: new GetReferenceDocumentDetailUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      maintenanceReportQueryService as unknown as MaintenanceReportQueryService,
      accountQueryService as unknown as AccountQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
    ),
  };
};

describe('GetReferenceDocumentDetailUsecase（生效版本与可见范围）', () => {
  it('工程师读取本公司资料：范围为本公司，无附件资料正常返回正文', async () => {
    const { usecase, queryService } = makeDetailUsecase();

    const result = await usecase.execute({
      session: engineerSession,
      documentId: DOCUMENT_ID,
    });

    expect(queryService.findDetail).toHaveBeenCalledWith({
      documentId: DOCUMENT_ID,
      scope: { kind: 'ORGANIZATION', organizationId: ORG_ID },
    });
    expect(result.contentSource).toBe('ORIGINAL');
    expect(result.contentText).toBe('处理经过与结论');
    expect(result.hasFile).toBe(false);
    expect(result.frozenReport).toBeNull();
    expect(result).not.toHaveProperty('createdByAccountId');
    expect(result).not.toHaveProperty('storageReference');
  });

  it('一级管理员读取：范围落到 GLOBAL（全公司正式资料）', async () => {
    const { usecase, queryService } = makeDetailUsecase({
      accountQueryService: makeAccountQueryService(1),
    });

    await usecase.execute({ session: levelOneAdminSession, documentId: DOCUMENT_ID });

    expect(queryService.findDetail).toHaveBeenCalledWith({
      documentId: DOCUMENT_ID,
      scope: { kind: 'GLOBAL' },
    });
  });

  it('报告来源且无管理修订：读取原始冻结版本并组装只读内容', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockResolvedValue(
      makeDetail({
        sourceKind: 'INDEPENDENT_REPORT',
        sourceReportId: REPORT_ID,
        sourceReportVersionId: VERSION_ID,
        organizationName: '甲方默认组织',
      }),
    );
    const maintenanceReportQueryService = makeMaintenanceReportQueryService();
    maintenanceReportQueryService.readVersionById.mockResolvedValue({
      id: VERSION_ID,
      reportId: REPORT_ID,
      versionNo: 2,
      schemaVersion: 1,
      submittedAt: new Date('2026-10-01T00:00:00.000Z'),
      payloadSnapshot: {
        sourceType: 'HISTORICAL_CASE',
        repairRequestId: null,
        title: '光刻机 Z 轴异常',
        customerFactoryName: '某晶圆厂',
        equipmentModelId: 94,
        equipmentModelText: null,
        maintenanceDate: '2026-09-30',
        maintenanceEngineerName: '工程师甲',
        alarms: [
          {
            alarmIndex: 1,
            alarmCode: '0123',
            alarmDescription: 'Z 轴超限',
            phaseCode: 'OCCURRENCE',
            resetResult: 'RESET_SUCCESS',
          },
        ],
        steps: [
          {
            stepNo: 1,
            stepCode: 'S1',
            phaseCode: 'ANALYSIS',
            partName: 'Z 轴电机',
            actionText: '检查电机接线',
            resultText: '接线松动',
            newAlarmCode: null,
            isValidNewBranch: false,
          },
        ],
        ai: { usage: 'NOT_USED' },
      },
    });

    const { usecase } = makeDetailUsecase({
      queryService,
      maintenanceReportQueryService,
    });
    const result = await usecase.execute({
      session: engineerSession,
      documentId: DOCUMENT_ID,
    });

    expect(maintenanceReportQueryService.readVersionById).toHaveBeenCalledWith(
      REPORT_ID,
      VERSION_ID,
    );
    expect(result.contentSource).toBe('FROZEN_REPORT');
    expect(result.frozenReport?.versionNo).toBe(2);
    expect(result.frozenReport?.alarms[0]?.alarmCode).toBe('0123');
    expect(result.frozenReport?.steps[0]?.partName).toBe('Z 轴电机');
    expect(result.contentText).toContain('光刻机 Z 轴异常');
    expect(result.contentText).toContain('Z 轴电机');
  });

  it('工单总结来源且无管理修订：读取冻结版本，来源与工单标识随快照透出，AI 空值不落 0', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockResolvedValue(
      makeDetail({
        sourceKind: 'WORK_ORDER_SUMMARY',
        sourceReportId: REPORT_ID,
        sourceReportVersionId: VERSION_ID,
      }),
    );
    const maintenanceReportQueryService = makeMaintenanceReportQueryService();
    maintenanceReportQueryService.readVersionById.mockResolvedValue({
      id: VERSION_ID,
      reportId: REPORT_ID,
      versionNo: 1,
      schemaVersion: 2,
      submittedAt: new Date('2026-11-10T00:00:00.000Z'),
      payloadSnapshot: {
        schemaVersion: 2,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: 950001,
        title: '工单维修总结：光源能量衰减',
        customerFactoryName: '某晶圆厂',
        equipmentModelId: 94,
        equipmentModelText: null,
        maintenanceDate: '2026-11-09',
        maintenanceEngineerName: '工程师乙',
        alarms: [
          {
            alarmIndex: 1,
            alarmCode: '0456',
            alarmDescription: null,
            phaseCode: 'OCCURRENCE',
            resetResult: 'RESET_SUCCESS',
          },
        ],
        steps: [
          {
            stepNo: 1,
            stepCode: 'S1',
            phaseCode: 'REPAIR',
            partName: null,
            actionText: '更换光源模块',
            resultText: '能量恢复正常',
            newAlarmCode: null,
            isValidNewBranch: false,
          },
        ],
        // 工程师只声明 USED、尚未补评分：缺键必须保持 null，不得误降级为 0
        ai: { usage: 'USED', note: 'AI 提示检查光源模块' },
      },
    });

    const { usecase } = makeDetailUsecase({ queryService, maintenanceReportQueryService });
    const result = await usecase.execute({
      session: engineerSession,
      documentId: DOCUMENT_ID,
    });

    expect(result.contentSource).toBe('FROZEN_REPORT');
    expect(result.frozenReport?.sourceType).toBe('WORK_ORDER_SUMMARY');
    expect(result.frozenReport?.repairRequestId).toBe(950001);
    expect(result.frozenReport?.ai.usage).toBe('USED');
    expect(result.frozenReport?.ai.score).toBeNull();
    expect(result.frozenReport?.ai.note).toBe('AI 提示检查光源模块');
    expect(result.contentText).toContain('工单维修总结：光源能量衰减');
  });

  it('冻结版本行存在但快照整体结构性缺失：失败关闭为 NOT_FOUND，不输出空正文、不回退实时工单内容', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockResolvedValue(
      makeDetail({
        sourceKind: 'WORK_ORDER_SUMMARY',
        sourceReportId: REPORT_ID,
        sourceReportVersionId: VERSION_ID,
      }),
    );
    const maintenanceReportQueryService = makeMaintenanceReportQueryService();
    // 任务 06 快照 schema 漂移/行损坏的极端形态：白名单键全部缺失
    maintenanceReportQueryService.readVersionById.mockResolvedValue({
      id: VERSION_ID,
      reportId: REPORT_ID,
      versionNo: 1,
      schemaVersion: 2,
      submittedAt: new Date('2026-11-10T00:00:00.000Z'),
      payloadSnapshot: {},
    });

    const { usecase } = makeDetailUsecase({ queryService, maintenanceReportQueryService });

    await expect(
      usecase.execute({ session: engineerSession, documentId: DOCUMENT_ID }),
    ).rejects.toMatchObject(notFound);
  });

  it('存在管理修订：生效正文为修订后内容，且恒附带原始冻结报告视图（授权追溯，冻结内容不变）', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockResolvedValue(
      makeDetail({
        sourceKind: 'WORK_ORDER_SUMMARY',
        sourceReportId: REPORT_ID,
        sourceReportVersionId: VERSION_ID,
        effectiveRevisionNo: 3,
      }),
    );
    queryService.findRevision.mockResolvedValue({
      revisionNo: 3,
      afterSnapshot: { contentText: '修订后的补充说明' },
    });
    const maintenanceReportQueryService = makeMaintenanceReportQueryService();
    maintenanceReportQueryService.readVersionById.mockResolvedValue({
      id: VERSION_ID,
      reportId: REPORT_ID,
      versionNo: 1,
      schemaVersion: 2,
      submittedAt: new Date('2026-11-10T00:00:00.000Z'),
      payloadSnapshot: {
        schemaVersion: 2,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: 950001,
        title: '工单维修总结：光源能量衰减',
        customerFactoryName: '某晶圆厂',
        equipmentModelId: 94,
        equipmentModelText: null,
        maintenanceDate: '2026-11-09',
        maintenanceEngineerName: '工程师乙',
        alarms: [],
        steps: [
          {
            stepNo: 1,
            stepCode: 'S1',
            phaseCode: 'REPAIR',
            partName: null,
            actionText: '更换光源模块',
            resultText: '能量恢复正常',
            newAlarmCode: null,
            isValidNewBranch: false,
          },
        ],
        ai: { usage: 'NOT_USED' },
      },
    });

    const { usecase } = makeDetailUsecase({ queryService, maintenanceReportQueryService });
    const result = await usecase.execute({
      session: engineerSession,
      documentId: DOCUMENT_ID,
    });

    expect(queryService.findRevision).toHaveBeenCalledWith(DOCUMENT_ID, 3);
    expect(maintenanceReportQueryService.readVersionById).toHaveBeenCalledWith(
      REPORT_ID,
      VERSION_ID,
    );
    expect(result.contentSource).toBe('CURRENT_REVISION');
    expect(result.contentText).toBe('修订后的补充说明');
    // 授权追溯：修订不替换/不消失原始冻结版本，版本号与内容仍为冻结快照事实
    expect(result.frozenReport?.versionId).toBe(VERSION_ID);
    expect(result.frozenReport?.versionNo).toBe(1);
    expect(result.frozenReport?.title).toBe('工单维修总结：光源能量衰减');
    expect(result.frozenReport?.steps[0]?.actionText).toBe('更换光源模块');
  });

  it('存在管理修订但冻结版本行缺失：失败关闭为 NOT_FOUND（数据定式破坏）', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockResolvedValue(
      makeDetail({
        sourceKind: 'INDEPENDENT_REPORT',
        sourceReportId: REPORT_ID,
        sourceReportVersionId: VERSION_ID,
        effectiveRevisionNo: 2,
      }),
    );
    queryService.findRevision.mockResolvedValue({
      revisionNo: 2,
      afterSnapshot: { contentText: '修订后的正文' },
    });
    const maintenanceReportQueryService = makeMaintenanceReportQueryService();
    maintenanceReportQueryService.readVersionById.mockResolvedValue(null);
    const { usecase } = makeDetailUsecase({ queryService, maintenanceReportQueryService });

    await expect(
      usecase.execute({ session: engineerSession, documentId: DOCUMENT_ID }),
    ).rejects.toMatchObject(notFound);
  });

  it('报告来源但冻结版本行缺失：失败关闭为 NOT_FOUND，不输出残缺正文', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockResolvedValue(
      makeDetail({
        sourceKind: 'INDEPENDENT_REPORT',
        sourceReportId: REPORT_ID,
        sourceReportVersionId: VERSION_ID,
      }),
    );
    const { usecase } = makeDetailUsecase({ queryService });

    await expect(
      usecase.execute({ session: engineerSession, documentId: DOCUMENT_ID }),
    ).rejects.toMatchObject(notFound);
  });

  it('下架/软删/跨公司：QueryService 统一 NOT_FOUND，详情不泄露状态', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockRejectedValue(
      new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问', {
        id: DOCUMENT_ID,
      }),
    );
    const { usecase } = makeDetailUsecase({ queryService });

    await expect(
      usecase.execute({
        session: {
          accountId: 900002,
          roles: ['ENGINEER'],
          activeRole: 'ENGINEER',
        } as unknown as UsecaseSession,
        documentId: DOCUMENT_ID,
      }),
    ).rejects.toMatchObject(notFound);
  });

  it('客户直接调用详情：在范围决议前拒绝（守卫层之外的兜底）', async () => {
    const { usecase, queryService } = makeDetailUsecase();

    await expect(
      usecase.execute({ session: customerSession, documentId: DOCUMENT_ID }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(queryService.findDetail).not.toHaveBeenCalled();
  });
});

describe('ListReferenceDocumentRevisionsUsecase（历史版本）', () => {
  const makeUsecase = (queryService: ReturnType<typeof makeQueryService>) =>
    new ListReferenceDocumentRevisionsUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      makeAccountQueryService() as unknown as AccountQueryService,
      makeOrganizationContextService() as unknown as TrustedOrganizationContextQueryService,
    );

  it('返回修订摘要、修订人昵称与该版本生效正文，不外发完整快照 JSON', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockResolvedValue(
      makeDetail({ sourceKind: 'WORK_ORDER_SUMMARY', sourceReportVersionId: VERSION_ID }),
    );
    queryService.listRevisions.mockResolvedValue([
      {
        revisionNo: 1,
        reason: '补充安全注意事项',
        actorAccountId: 900001,
        createdAt: new Date('2026-11-05T00:00:00.000Z'),
        contentText: 'v1 生效正文',
      },
      {
        revisionNo: 2,
        reason: '更正归属公司',
        actorAccountId: 900001,
        createdAt: new Date('2026-11-06T00:00:00.000Z'),
        contentText: null,
      },
    ]);

    const result = await makeUsecase(queryService).execute({
      session: engineerSession,
      documentId: DOCUMENT_ID,
    });

    expect(result).toEqual({
      documentId: DOCUMENT_ID,
      currentRevisionNo: 0,
      sourceKind: 'WORK_ORDER_SUMMARY',
      sourceReportVersionId: VERSION_ID,
      revisions: [
        {
          revisionNo: 1,
          reason: '补充安全注意事项',
          actorNickname: '工程师甲',
          createdAt: new Date('2026-11-05T00:00:00.000Z'),
          contentText: 'v1 生效正文',
        },
        {
          revisionNo: 2,
          reason: '更正归属公司',
          actorNickname: '工程师甲',
          createdAt: new Date('2026-11-06T00:00:00.000Z'),
          contentText: null,
        },
      ],
    });
    // 授权追溯：逐版本可见该修订的具体生效内容，而非仅版本号
    expect(result.revisions[0]?.contentText).toBe('v1 生效正文');
  });

  it('不可见资料：先经详情校验可见性，直接返回 NOT_FOUND 且不读修订', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockRejectedValue(
      new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问'),
    );

    await expect(
      makeUsecase(queryService).execute({ session: engineerSession, documentId: DOCUMENT_ID }),
    ).rejects.toMatchObject(notFound);
    expect(queryService.listRevisions).not.toHaveBeenCalled();
  });

  it('客户直接调用：拒绝且不读取任何资料', async () => {
    const queryService = makeQueryService();
    await expect(
      makeUsecase(queryService).execute({ session: customerSession, documentId: DOCUMENT_ID }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(queryService.findDetail).not.toHaveBeenCalled();
  });
});

describe('GetReferenceDocumentFileUsecase（授权原件下载）', () => {
  const makeUsecase = (
    params: {
      queryService?: ReturnType<typeof makeQueryService>;
      storage?: ReferenceDocumentStorage;
    } = {},
  ) => {
    const queryService = params.queryService ?? makeQueryService();
    const storage =
      params.storage ??
      ({
        open: jest.fn().mockResolvedValue({ stream: 'mock', byteSize: 10 }),
      } as unknown as ReferenceDocumentStorage);
    return {
      queryService,
      storage,
      usecase: new GetReferenceDocumentFileUsecase(
        queryService as unknown as ReferenceDocumentQueryService,
        makeAccountQueryService() as unknown as AccountQueryService,
        makeOrganizationContextService() as unknown as TrustedOrganizationContextQueryService,
        storage,
      ),
    };
  };

  it('合法无附件资料：不读取存储，返回 FILE_NOT_AVAILABLE', async () => {
    const { usecase, storage } = makeUsecase();
    await expect(
      usecase.execute({ session: engineerSession, documentId: DOCUMENT_ID }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.FILE_NOT_AVAILABLE });
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('一级管理员可下载全范围资料', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockResolvedValue(
      makeDetail({
        storageReference: 'reference-documents/1/a.pdf',
        originalFilename: 'a.pdf',
        mimeType: 'application/pdf',
        hasFile: true,
      }),
    );
    const storage = {
      open: jest.fn().mockResolvedValue({ stream: 'mock', byteSize: 10 }),
    } as unknown as ReferenceDocumentStorage;
    const usecase = new GetReferenceDocumentFileUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      makeAccountQueryService(1) as unknown as AccountQueryService,
      makeOrganizationContextService() as unknown as TrustedOrganizationContextQueryService,
      storage,
    );

    await usecase.execute({ session: levelOneAdminSession, documentId: DOCUMENT_ID });

    expect(queryService.findDetail).toHaveBeenCalledWith({
      documentId: DOCUMENT_ID,
      scope: { kind: 'GLOBAL' },
    });
  });

  it('下架/旧地址：QueryService NOT_FOUND 原样上抛，不读取存储', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockRejectedValue(
      new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问'),
    );
    const { usecase, storage } = makeUsecase({ queryService });

    await expect(
      usecase.execute({ session: engineerSession, documentId: DOCUMENT_ID }),
    ).rejects.toMatchObject(notFound);
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('二级管理员下载他司资料：按本公司范围查询不命中，NOT_FOUND 且不读取存储', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockRejectedValue(
      new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问'),
    );
    const storage = {
      open: jest.fn().mockResolvedValue({ stream: 'mock', byteSize: 10 }),
    } as unknown as ReferenceDocumentStorage;
    const usecase = new GetReferenceDocumentFileUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      makeAccountQueryService(2) as unknown as AccountQueryService,
      makeOrganizationContextService() as unknown as TrustedOrganizationContextQueryService,
      storage,
    );

    await expect(
      usecase.execute({ session: levelTwoAdminSession, documentId: DOCUMENT_ID }),
    ).rejects.toMatchObject(notFound);
    expect(queryService.findDetail).toHaveBeenCalledWith({
      documentId: DOCUMENT_ID,
      scope: { kind: 'ORGANIZATION', organizationId: ORG_ID },
    });
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('客户直接调用下载：拒绝且不读取任何资料', async () => {
    const { usecase, queryService, storage } = makeUsecase();
    await expect(
      usecase.execute({ session: customerSession, documentId: DOCUMENT_ID }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(queryService.findDetail).not.toHaveBeenCalled();
    expect(storage.open).not.toHaveBeenCalled();
  });
});
