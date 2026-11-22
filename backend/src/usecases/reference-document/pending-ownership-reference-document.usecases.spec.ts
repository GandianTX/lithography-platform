// src/usecases/reference-document/pending-ownership-reference-document.usecases.spec.ts

/// <reference types="jest" />
/**
 * 归属待核实清单 / 详情用例单测（任务 07 R061-01，一级管理员专用入口）。
 *
 * 覆盖：
 * - 一级管理员：清单（withTotal 恒真 + creatorNickname 富集）与 PENDING 详情正常返回；
 * - 权限拒绝：工程师、二级管理员（admin_level = 2）、缺等级与客户一律
 *   INSUFFICIENT_PERMISSIONS（权限拒绝而非资源不可见）；
 * - 非 PENDING 条目（已确认/已下架）：统一 NOT_FOUND，不泄露状态与存在性；
 * - findDetail 调用契约：GLOBAL 范围 + includeUnpublished 写路径放宽；
 * - 生效正文口径与普通详情一致（CURRENT_REVISION 走修订快照）。
 */
import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  DomainError,
  PERMISSION_ERROR,
  REFERENCE_DOCUMENT_ERROR,
} from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { GetPendingOwnershipReferenceDocumentDetailUsecase } from './get-pending-ownership-reference-document-detail.usecase';
import { ListPendingOwnershipReferenceDocumentsUsecase } from './list-pending-ownership-reference-documents.usecase';

const makeAccountQueryService = (adminLevel: number | null) =>
  ({
    findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map([[900001, '管理员甲']])),
    findAdminLevelByAccountId: jest.fn().mockResolvedValue(adminLevel),
  }) as unknown as jest.Mocked<
    Pick<AccountQueryService, 'findNicknamesByAccountIds' | 'findAdminLevelByAccountId'>
  > &
    AccountQueryService;

const makeReferenceDocumentQueryService = () =>
  ({
    listPendingOwnershipDocuments: jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
    }),
    findDetail: jest.fn(),
    findRevision: jest.fn().mockResolvedValue(null),
  }) as unknown as jest.Mocked<
    Pick<
      ReferenceDocumentQueryService,
      'listPendingOwnershipDocuments' | 'findDetail' | 'findRevision'
    >
  > &
    ReferenceDocumentQueryService;

const makeMaintenanceReportQueryService = () =>
  ({
    readVersionById: jest.fn().mockResolvedValue(null),
  }) as unknown as jest.Mocked<Pick<MaintenanceReportQueryService, 'readVersionById'>> &
    MaintenanceReportQueryService;

const session = (roles: string[]): UsecaseSession =>
  ({ accountId: 900001, roles, activeRole: roles[0] }) as UsecaseSession;

const adminSession = session(['SUPER_ADMIN']);
const engineerSession = session(['ENGINEER']);

const pendingDetailQueryResult = {
  id: 970101,
  title: '待核实归属资料',
  documentType: 'MATERIAL',
  equipmentModelId: null,
  equipmentModelName: null,
  equipmentModelText: null,
  description: '说明',
  originalFilename: null,
  mimeType: null,
  storageReference: null,
  hasFile: false,
  contentText: '正文',
  organizationName: '未知组织',
  ingestMethod: 'ADMIN_DIRECT',
  sourceKind: 'MATERIAL',
  sourceReportId: null,
  sourceReportVersionId: null,
  publicationStatus: 'ONLINE',
  ownershipStatus: 'PENDING',
  effectiveRevisionNo: 0,
  schemaVersion: 1,
  caseDetail: null,
  createdByAccountId: 900001,
  ownerOrganizationId: null,
  createdAt: new Date('2026-11-01T00:00:00.000Z'),
  updatedAt: new Date('2026-11-02T00:00:00.000Z'),
};

const pagination = {
  mode: 'OFFSET' as const,
  page: 1,
  pageSize: 10,
  withTotal: true,
};

describe('ListPendingOwnershipReferenceDocumentsUsecase（任务 07 R061-01）', () => {
  it('一级管理员：查询全公司 PENDING 清单，withTotal 恒真并富集创建人昵称', async () => {
    const queryService = makeReferenceDocumentQueryService();
    const accountQueryService = makeAccountQueryService(1);
    queryService.listPendingOwnershipDocuments.mockResolvedValue({
      items: [
        {
          id: 970101,
          title: '待核实归属资料',
          documentType: 'MATERIAL',
          equipmentModelId: null,
          equipmentModelName: null,
          equipmentModelText: null,
          description: null,
          originalFilename: null,
          organizationName: '未知组织',
          ingestMethod: 'ADMIN_DIRECT',
          sourceKind: 'MATERIAL',
          effectiveRevisionNo: 0,
          caseHandlingStatus: null,
          createdByAccountId: 900001,
          createdAt: new Date('2026-11-01T00:00:00.000Z'),
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    const usecase = new ListPendingOwnershipReferenceDocumentsUsecase(
      queryService,
      accountQueryService,
    );
    const result = await usecase.execute({ session: adminSession, pagination });

    expect(queryService.listPendingOwnershipDocuments).toHaveBeenCalledWith({
      pagination: { page: 1, pageSize: 10, withTotal: true },
    });
    expect(result.total).toBe(1);
    expect(result.items[0].creatorNickname).toBe('管理员甲');
    // 账号 ID 不进入对外视图
    expect((result.items[0] as Record<string, unknown>).createdByAccountId).toBeUndefined();
  });

  it('二级管理员（admin_level = 2）：INSUFFICIENT_PERMISSIONS', async () => {
    const queryService = makeReferenceDocumentQueryService();
    const accountQueryService = makeAccountQueryService(2);
    const usecase = new ListPendingOwnershipReferenceDocumentsUsecase(
      queryService,
      accountQueryService,
    );

    await expect(usecase.execute({ session: adminSession, pagination })).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
    expect(queryService.listPendingOwnershipDocuments).not.toHaveBeenCalled();
  });

  it('缺管理员等级：INSUFFICIENT_PERMISSIONS', async () => {
    const usecase = new ListPendingOwnershipReferenceDocumentsUsecase(
      makeReferenceDocumentQueryService(),
      makeAccountQueryService(null),
    );

    await expect(usecase.execute({ session: adminSession, pagination })).rejects.toBeInstanceOf(
      DomainError,
    );
  });

  it('工程师：INSUFFICIENT_PERMISSIONS', async () => {
    const usecase = new ListPendingOwnershipReferenceDocumentsUsecase(
      makeReferenceDocumentQueryService(),
      makeAccountQueryService(null),
    );

    await expect(usecase.execute({ session: engineerSession, pagination })).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
  });

  it('非 OFFSET 分页：INVALID_PARAMS，不触发任何查询', async () => {
    const queryService = makeReferenceDocumentQueryService();
    const usecase = new ListPendingOwnershipReferenceDocumentsUsecase(
      queryService,
      makeAccountQueryService(1),
    );

    await expect(
      usecase.execute({
        session: adminSession,
        pagination: { mode: 'CURSOR' as never, page: 1, pageSize: 10, withTotal: true },
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
    expect(queryService.listPendingOwnershipDocuments).not.toHaveBeenCalled();
  });
});

describe('GetPendingOwnershipReferenceDocumentDetailUsecase（任务 07 R061-01）', () => {
  const buildUsecase = (
    queryService = makeReferenceDocumentQueryService(),
    accountQueryService = makeAccountQueryService(1),
  ) =>
    new GetPendingOwnershipReferenceDocumentDetailUsecase(
      queryService,
      makeMaintenanceReportQueryService(),
      accountQueryService,
    );

  it('一级管理员：GLOBAL 范围 + includeUnpublished 读 PENDING 详情，正文口径与普通详情一致', async () => {
    const queryService = makeReferenceDocumentQueryService();
    queryService.findDetail.mockResolvedValue(pendingDetailQueryResult);
    queryService.findRevision.mockResolvedValue({
      revisionNo: 1,
      afterSnapshot: { contentText: '修订后正文' },
    });
    const revisedDetail = {
      ...pendingDetailQueryResult,
      effectiveRevisionNo: 1,
    };
    queryService.findDetail.mockResolvedValue(revisedDetail);

    const usecase = buildUsecase(queryService);
    const result = await usecase.execute({ session: adminSession, documentId: 970101 });

    expect(queryService.findDetail).toHaveBeenCalledWith({
      documentId: 970101,
      scope: { kind: 'GLOBAL' },
      includeUnpublished: true,
    });
    expect(result.contentSource).toBe('CURRENT_REVISION');
    expect(result.contentText).toBe('修订后正文');
    expect(result.creatorNickname).toBe('管理员甲');
    expect((result as Record<string, unknown>).createdByAccountId).toBeUndefined();
  });

  it('非 PENDING 条目（归属已确认）：统一 NOT_FOUND，不泄露状态', async () => {
    const queryService = makeReferenceDocumentQueryService();
    queryService.findDetail.mockResolvedValue({
      ...pendingDetailQueryResult,
      ownershipStatus: 'CONFIRMED',
    });

    const usecase = buildUsecase(queryService);
    await expect(
      usecase.execute({ session: adminSession, documentId: 970101 }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.NOT_FOUND });
  });

  it('二级管理员（admin_level = 2）：INSUFFICIENT_PERMISSIONS，不触发详情查询', async () => {
    const queryService = makeReferenceDocumentQueryService();
    const usecase = buildUsecase(queryService, makeAccountQueryService(2));

    await expect(
      usecase.execute({ session: adminSession, documentId: 970101 }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(queryService.findDetail).not.toHaveBeenCalled();
  });

  it('工程师：INSUFFICIENT_PERMISSIONS', async () => {
    const usecase = buildUsecase(
      makeReferenceDocumentQueryService(),
      makeAccountQueryService(null),
    );

    await expect(
      usecase.execute({ session: engineerSession, documentId: 970101 }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
  });

  it('非法 documentId：INVALID_PARAMS，不触发任何查询', async () => {
    const queryService = makeReferenceDocumentQueryService();
    const usecase = buildUsecase(queryService);

    await expect(usecase.execute({ session: adminSession, documentId: 0 })).rejects.toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
    });
    expect(queryService.findDetail).not.toHaveBeenCalled();
  });
});
