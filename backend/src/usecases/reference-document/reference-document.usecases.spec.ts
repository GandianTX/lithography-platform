// src/usecases/reference-document/reference-document.usecases.spec.ts

/// <reference types="jest" />
import { Readable } from 'node:stream';

import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  DomainError,
  INPUT_NORMALIZE_ERROR,
  ORGANIZATION_ERROR,
  PERMISSION_ERROR,
  REFERENCE_DOCUMENT_ERROR,
} from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { ReferenceDocumentCaseDetailService } from '@src/modules/lithography/reference-document-case-detail.service';
import type { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import type { ReferenceDocumentService } from '@src/modules/lithography/reference-document.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { GetReferenceDocumentDetailUsecase } from './get-reference-document-detail.usecase';
import { GetReferenceDocumentFileUsecase } from './get-reference-document-file.usecase';
import { ListReferenceDocumentsUsecase } from './list-reference-documents.usecase';
import { SoftDeleteReferenceDocumentUsecase } from './soft-delete-reference-document.usecase';
import { UpdateReferenceDocumentCaseUsecase } from './update-reference-document-case.usecase';
import type { ReferenceDocumentRevisionService } from '@src/modules/lithography/reference-document-revision.service';
import type { ManagementAuditService } from '@src/modules/lithography/management-audit.service';

const makeQueryService = () => ({
  listDocuments: jest.fn().mockResolvedValue({ items: [], page: 1, pageSize: 10 }),
  findDetail: jest.fn(),
  findRevision: jest.fn().mockResolvedValue(null),
  listPublishedDocumentIdsByReportIds: jest.fn().mockResolvedValue(new Map()),
});

/** 同域维修报告读侧替身：默认无冻结版本（MATERIAL 详情不触发） */
const makeMaintenanceReportQueryService = () => ({
  readVersionById: jest.fn().mockResolvedValue(null),
  // 任务 07 P2：报告来源详情装配会读冻结版本附件绑定（无绑定如实为 null）
  readVersionAttachments: jest.fn().mockResolvedValue([]),
  readAttachmentsByIds: jest.fn().mockResolvedValue([]),
});

const makeWriteService = () => ({
  insertDocument: jest.fn().mockResolvedValue({ id: 970101 }),
  updateDocument: jest.fn().mockResolvedValue({ id: 970001 }),
  softDeleteDocument: jest.fn().mockResolvedValue({ kind: 'DELETED', id: 970001 }),
});

const makeCaseDetailService = () => ({
  insertCaseDetail: jest.fn().mockResolvedValue({ documentId: 970001 }),
  updateCaseDetail: jest.fn().mockResolvedValue({ documentId: 970001 }),
});

const makeModelQueryService = () => ({
  findModelById: jest.fn().mockResolvedValue({ id: 930001, modelCode: 'M', modelName: '型号' }),
});

const makeAccountQueryService = () => ({
  findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map([[900001, '管理员甲']])),
  // 管理员等级读侧：缺省 null（读侧范围决议回落本公司口径，保持工程师/降级管理员原行为），
  // 一级管理员在专门用例中覆写
  findAdminLevelByAccountId: jest.fn().mockResolvedValue(null),
});

/** 可信组织上下文替身：缺省解析到甲方默认组织（与 Seed 口径一致） */
const makeOrganizationContextService = () => ({
  resolveForAccount: jest.fn().mockResolvedValue({
    membershipId: 950001,
    organizationId: 910001,
    organizationCode: 'CLIENT_DEFAULT',
    organizationName: '甲方默认组织',
    organizationKind: 'CLIENT',
    memberRole: 'ADMIN',
  }),
});

const makeTransactionRunner = () =>
  ({
    run: jest.fn((cb: (ctx: unknown) => unknown) => cb({ transaction: 'mock' })),
  }) as unknown as TransactionRunner;

const session = (roles: string[]): UsecaseSession =>
  ({ accountId: 900001, roles, activeRole: roles[0] }) as UsecaseSession;

const detailQueryResult = (overrides: Record<string, unknown> = {}) => ({
  id: 970001,
  title: '错误码手册',
  documentType: 'ERROR_CODE_MANUAL',
  equipmentModelId: null,
  equipmentModelName: null,
  equipmentModelText: null,
  description: '说明',
  originalFilename: null,
  mimeType: null,
  contentText: '内容',
  organizationName: '甲方默认组织',
  ingestMethod: 'ADMIN_DIRECT',
  sourceKind: 'MATERIAL',
  sourceReportId: null,
  sourceReportVersionId: null,
  publicationStatus: 'ONLINE',
  ownershipStatus: 'CONFIRMED',
  effectiveRevisionNo: 0,
  schemaVersion: 1,
  ownerOrganizationId: 910001,
  caseDetail: null,
  // 内部装配字段（QueryService 返回、DTO 视图剥离）：供下载/编辑防御判定使用
  storageReference: null,
  createdByAccountId: 900001,
  createdAt: new Date('2026-01-02T10:00:00.000Z'),
  updatedAt: new Date('2026-01-02T10:00:00.000Z'),
  ...overrides,
});

describe('ListReferenceDocumentsUsecase', () => {
  it('工程师可读；OFFSET 分页透传，withTotal 缺省 false；筛选透传', async () => {
    const queryService = makeQueryService();
    const usecase = new ListReferenceDocumentsUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      makeAccountQueryService() as unknown as AccountQueryService,
      makeOrganizationContextService() as unknown as TrustedOrganizationContextQueryService,
    );

    await usecase.execute({
      session: session(['ENGINEER']),
      pagination: { mode: 'OFFSET', page: 2, pageSize: 5 },
      filter: { title: '手册', documentType: 'MANUAL', equipmentModelId: 930001 },
    });

    expect(queryService.listDocuments).toHaveBeenCalledWith({
      filter: { title: '手册', documentType: 'MANUAL', equipmentModelId: 930001 },
      pagination: { page: 2, pageSize: 5, withTotal: false },
      scope: { kind: 'ORGANIZATION', organizationId: 910001 },
    });
  });

  it('空白筛选词规范化为无筛选（与前端「空白搜索词=无筛选」口径一致，防字面量意外命中）', async () => {
    const queryService = makeQueryService();
    const usecase = new ListReferenceDocumentsUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      makeAccountQueryService() as unknown as AccountQueryService,
      makeOrganizationContextService() as unknown as TrustedOrganizationContextQueryService,
    );

    await usecase.execute({
      session: session(['ENGINEER']),
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
      filter: { title: '   ', documentType: '', equipmentModelId: 930001 },
    });

    expect(queryService.listDocuments).toHaveBeenCalledWith({
      filter: { title: undefined, documentType: undefined, equipmentModelId: 930001 },
      pagination: { page: 1, pageSize: 10, withTotal: false },
      scope: { kind: 'ORGANIZATION', organizationId: 910001 },
    });
  });

  it('SUPER_ADMIN 按角色继承规则准入读（hasRole 层级展开）', async () => {
    const queryService = makeQueryService();
    const usecase = new ListReferenceDocumentsUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      makeAccountQueryService() as unknown as AccountQueryService,
      makeOrganizationContextService() as unknown as TrustedOrganizationContextQueryService,
    );

    await expect(
      usecase.execute({
        session: session(['SUPER_ADMIN']),
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
        filter: {},
      }),
    ).resolves.toBeTruthy();
  });

  it('CUSTOMER 读被拒（INSUFFICIENT_PERMISSIONS，读侧不泄露其他信息）', async () => {
    const queryService = makeQueryService();
    const usecase = new ListReferenceDocumentsUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      makeAccountQueryService() as unknown as AccountQueryService,
      makeOrganizationContextService() as unknown as TrustedOrganizationContextQueryService,
    );

    await expect(
      usecase.execute({
        session: session(['CUSTOMER']),
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
        filter: {},
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(queryService.listDocuments).not.toHaveBeenCalled();
  });

  it('CURSOR 分页第一版拒绝；页大小超上限在用例层钳制为 100', async () => {
    const queryService = makeQueryService();
    const usecase = new ListReferenceDocumentsUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      makeAccountQueryService() as unknown as AccountQueryService,
      makeOrganizationContextService() as unknown as TrustedOrganizationContextQueryService,
    );

    await expect(
      usecase.execute({
        session: session(['ENGINEER']),
        pagination: { mode: 'CURSOR', limit: 5 },
        filter: {},
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });

    await usecase.execute({
      session: session(['ENGINEER']),
      pagination: { mode: 'OFFSET', page: 1, pageSize: 500 },
      filter: {},
    });
    expect(queryService.listDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({ pagination: expect.objectContaining({ pageSize: 100 }) }),
    );
  });

  it('创建人昵称批量富集：账号 ID 不进入对外视图，缺失回落「未知用户」', async () => {
    const queryService = makeQueryService();
    queryService.listDocuments.mockResolvedValue({
      items: [detailQueryResult(), detailQueryResult({ id: 970003, createdByAccountId: 999999 })],
      page: 1,
      pageSize: 10,
      total: 2,
    });
    const accountQueryService = makeAccountQueryService();
    const usecase = new ListReferenceDocumentsUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      accountQueryService as unknown as AccountQueryService,
      makeOrganizationContextService() as unknown as TrustedOrganizationContextQueryService,
    );

    const result = await usecase.execute({
      session: session(['ENGINEER']),
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
      filter: {},
    });

    expect(accountQueryService.findNicknamesByAccountIds).toHaveBeenCalledWith([900001, 999999]);
    expect(result.items[0]).toMatchObject({ creatorNickname: '管理员甲' });
    expect(result.items[1]).toMatchObject({ creatorNickname: '未知用户' });
    expect(result.items[0]).not.toHaveProperty('createdByAccountId');
  });

  it('案例处理状态筛选词规范化透传（空白视为无筛选，A-PR0 §4.3 新增筛选）', async () => {
    const queryService = makeQueryService();
    const usecase = new ListReferenceDocumentsUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      makeAccountQueryService() as unknown as AccountQueryService,
      makeOrganizationContextService() as unknown as TrustedOrganizationContextQueryService,
    );

    await usecase.execute({
      session: session(['SUPER_ADMIN']),
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
      filter: { caseHandlingStatus: ' RESOLVED ' },
    });

    expect(queryService.listDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.objectContaining({ caseHandlingStatus: 'RESOLVED' }),
        scope: { kind: 'ORGANIZATION', organizationId: 910001 },
      }),
    );
  });

  it('无有效组织成员关系拒绝（ORGANIZATION_NO_ACTIVE_MEMBERSHIP），不进入资料查询', async () => {
    const queryService = makeQueryService();
    const organizationContextService = makeOrganizationContextService();
    organizationContextService.resolveForAccount.mockRejectedValue(
      new DomainError(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, '当前账号没有有效组织成员关系'),
    );
    const usecase = new ListReferenceDocumentsUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      makeAccountQueryService() as unknown as AccountQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
    );

    await expect(
      usecase.execute({
        session: session(['ENGINEER']),
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
        filter: {},
      }),
    ).rejects.toMatchObject({ code: ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP });
    expect(queryService.listDocuments).not.toHaveBeenCalled();
  });

  it('一级管理员（admin_level=1）跨公司列表：GLOBAL 范围不按组织过滤，不依赖本人成员关系', async () => {
    const queryService = makeQueryService();
    const accountQueryService = makeAccountQueryService();
    accountQueryService.findAdminLevelByAccountId.mockResolvedValue(1);
    const organizationContextService = makeOrganizationContextService();
    organizationContextService.resolveForAccount.mockRejectedValue(
      new DomainError(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, '当前账号没有有效组织成员关系'),
    );
    const usecase = new ListReferenceDocumentsUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      accountQueryService as unknown as AccountQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
    );

    await expect(
      usecase.execute({
        session: session(['SUPER_ADMIN']),
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
        filter: {},
      }),
    ).resolves.toBeTruthy();
    // 一级全公司（功能 V5.6 R055-01）：GLOBAL 范围，不按组织收窄
    expect(queryService.listDocuments).toHaveBeenCalledWith({
      filter: {
        title: undefined,
        documentType: undefined,
        equipmentModelId: undefined,
        caseHandlingStatus: undefined,
      },
      pagination: { page: 1, pageSize: 10, withTotal: false },
      scope: { kind: 'GLOBAL' },
    });
  });

  it('二级管理员（admin_level=2）列表：仅本公司 ORGANIZATION 范围，不扩大', async () => {
    const queryService = makeQueryService();
    const accountQueryService = makeAccountQueryService();
    accountQueryService.findAdminLevelByAccountId.mockResolvedValue(2);
    const usecase = new ListReferenceDocumentsUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      accountQueryService as unknown as AccountQueryService,
      makeOrganizationContextService() as unknown as TrustedOrganizationContextQueryService,
    );

    await usecase.execute({
      session: session(['SUPER_ADMIN']),
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
      filter: {},
    });

    // 二级本公司（功能 V5.6 R056-01）：仍按可信组织上下文收窄
    expect(queryService.listDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: 'ORGANIZATION', organizationId: 910001 } }),
    );
  });
});

describe('GetReferenceDocumentDetailUsecase', () => {
  it('工程师可读详情；昵称富集后账号 ID 不外泄', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockResolvedValue(detailQueryResult());
    const usecase = new GetReferenceDocumentDetailUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      makeMaintenanceReportQueryService() as unknown as MaintenanceReportQueryService,
      makeAccountQueryService() as unknown as AccountQueryService,
      makeOrganizationContextService() as unknown as TrustedOrganizationContextQueryService,
    );

    const result = await usecase.execute({
      session: session(['ENGINEER']),
      documentId: 970001,
    });

    // 详情读取带可信组织范围（A-PR0 §2.1：不取客户端自报）
    expect(queryService.findDetail).toHaveBeenCalledWith({
      documentId: 970001,
      scope: { kind: 'ORGANIZATION', organizationId: 910001 },
    });
    expect(result).toMatchObject({
      id: 970001,
      creatorNickname: '管理员甲',
      organizationName: '甲方默认组织',
      ingestMethod: 'ADMIN_DIRECT',
      caseDetail: null,
    });
    expect(result).not.toHaveProperty('createdByAccountId');
  });

  it('资料 ID 非法拒绝；CUSTOMER 读取被拒', async () => {
    const queryService = makeQueryService();
    const usecase = new GetReferenceDocumentDetailUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      makeMaintenanceReportQueryService() as unknown as MaintenanceReportQueryService,
      makeAccountQueryService() as unknown as AccountQueryService,
      makeOrganizationContextService() as unknown as TrustedOrganizationContextQueryService,
    );

    await expect(
      usecase.execute({ session: session(['ENGINEER']), documentId: 0 }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
    await expect(
      usecase.execute({ session: session(['CUSTOMER']), documentId: 970001 }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(queryService.findDetail).not.toHaveBeenCalled();
  });

  it('不存在/已软删（QueryService 统一 NOT_FOUND）原样上抛同码', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockRejectedValue(
      new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问', {
        id: 970004,
      }),
    );
    const usecase = new GetReferenceDocumentDetailUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      makeMaintenanceReportQueryService() as unknown as MaintenanceReportQueryService,
      makeAccountQueryService() as unknown as AccountQueryService,
      makeOrganizationContextService() as unknown as TrustedOrganizationContextQueryService,
    );

    await expect(
      usecase.execute({ session: session(['ENGINEER']), documentId: 970004 }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.NOT_FOUND });
  });

  it('无有效组织成员关系拒绝（ORGANIZATION_NO_ACTIVE_MEMBERSHIP），不读取任何资料', async () => {
    const queryService = makeQueryService();
    const organizationContextService = makeOrganizationContextService();
    organizationContextService.resolveForAccount.mockRejectedValue(
      new DomainError(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, '当前账号没有有效组织成员关系'),
    );
    const usecase = new GetReferenceDocumentDetailUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      makeMaintenanceReportQueryService() as unknown as MaintenanceReportQueryService,
      makeAccountQueryService() as unknown as AccountQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
    );

    await expect(
      usecase.execute({ session: session(['ENGINEER']), documentId: 970001 }),
    ).rejects.toMatchObject({ code: ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP });
    expect(queryService.findDetail).not.toHaveBeenCalled();
  });

  it('一级管理员（admin_level=1）跨公司详情：GLOBAL 范围不按组织过滤，无本人成员关系仍可读', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockResolvedValue(detailQueryResult());
    const accountQueryService = makeAccountQueryService();
    accountQueryService.findAdminLevelByAccountId.mockResolvedValue(1);
    const organizationContextService = makeOrganizationContextService();
    organizationContextService.resolveForAccount.mockRejectedValue(
      new DomainError(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, '当前账号没有有效组织成员关系'),
    );
    const usecase = new GetReferenceDocumentDetailUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      makeMaintenanceReportQueryService() as unknown as MaintenanceReportQueryService,
      accountQueryService as unknown as AccountQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
    );

    await expect(
      usecase.execute({ session: session(['SUPER_ADMIN']), documentId: 970001 }),
    ).resolves.toBeTruthy();
    // 一级全公司（功能 V5.6 R055-02）：GLOBAL 范围，不按组织收窄
    expect(queryService.findDetail).toHaveBeenCalledWith({
      documentId: 970001,
      scope: { kind: 'GLOBAL' },
    });
  });

  it('二级管理员（admin_level=2）跨公司详情被拒：仅本公司范围由 QueryService 谓词拒绝', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockRejectedValue(
      new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问', {
        id: 970001,
      }),
    );
    const accountQueryService = makeAccountQueryService();
    accountQueryService.findAdminLevelByAccountId.mockResolvedValue(2);
    const organizationContextService = makeOrganizationContextService();
    organizationContextService.resolveForAccount.mockResolvedValue({
      membershipId: 950002,
      organizationId: 910002,
      organizationCode: 'ORG-DEV-B',
      organizationName: '乙方公司',
      organizationKind: 'CLIENT',
      memberRole: 'ADMIN',
    });
    const usecase = new GetReferenceDocumentDetailUsecase(
      queryService as unknown as ReferenceDocumentQueryService,
      makeMaintenanceReportQueryService() as unknown as MaintenanceReportQueryService,
      accountQueryService as unknown as AccountQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
    );

    // 二级管理员的可信公司为 910002：谓词按该公司过滤，他司条目统一 NOT_FOUND
    await expect(
      usecase.execute({ session: session(['SUPER_ADMIN']), documentId: 970001 }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.NOT_FOUND });
    expect(queryService.findDetail).toHaveBeenCalledWith({
      documentId: 970001,
      scope: { kind: 'ORGANIZATION', organizationId: 910002 },
    });
  });
});

describe('SoftDeleteReferenceDocumentUsecase（任务 07 R053 原作者删除本人正式资料）', () => {
  const makeRevisionService = () => ({
    insertRevision: jest.fn().mockResolvedValue(undefined),
    advanceCurrentRevision: jest.fn().mockResolvedValue('ADVANCED'),
  });
  const makeAuditService = () => ({
    appendDocumentEvent: jest.fn().mockResolvedValue(undefined),
  });
  const makeAccountQuery = (adminLevel: number | null = null) => ({
    findAdminLevelByAccountId: jest.fn().mockResolvedValue(adminLevel),
    findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map()),
  });
  const makeMaintenanceReports = () => ({ readVersionById: jest.fn().mockResolvedValue(null) });

  const makeUsecase = (
    overrides: {
      revisionService?: ReturnType<typeof makeRevisionService>;
      queryService?: ReturnType<typeof makeQueryService>;
      accountQuery?: ReturnType<typeof makeAccountQuery>;
    } = {},
  ) => {
    const revisionService = overrides.revisionService ?? makeRevisionService();
    const queryService = overrides.queryService ?? makeQueryService();
    if (!overrides.queryService) {
      queryService.findDetail.mockResolvedValue(detailQueryResult({ effectiveRevisionNo: 2 }));
      // 生效修订读替身：删除快照需要读取当时生效正文（CURRENT_REVISION 来源）
      queryService.findRevision.mockResolvedValue({
        revisionNo: 2,
        afterSnapshot: { schema_version: 1, contentText: '内容' },
      });
    }
    const accountQuery = overrides.accountQuery ?? makeAccountQuery();
    const auditService = makeAuditService();
    return {
      revisionService,
      queryService,
      accountQuery,
      auditService,
      usecase: new SoftDeleteReferenceDocumentUsecase(
        queryService as unknown as ReferenceDocumentQueryService,
        makeMaintenanceReports() as unknown as MaintenanceReportQueryService,
        revisionService as unknown as ReferenceDocumentRevisionService,
        auditService as unknown as ManagementAuditService,
        accountQuery as unknown as AccountQueryService,
        makeTransactionRunner(),
      ),
    };
  };

  it('原作者（工程师）删除本人条目：AUTHOR 范围锁定读 + 修订行 + 条件推进，无关键审计', async () => {
    const { usecase, revisionService, queryService, auditService } = makeUsecase();

    await expect(
      usecase.execute({
        session: session(['ENGINEER']),
        documentId: 970001,
        expectedVersion: 2,
      }),
    ).resolves.toEqual({ id: 970001 });
    expect(queryService.findDetail).toHaveBeenCalledWith({
      documentId: 970001,
      scope: { kind: 'AUTHOR', accountId: 900001 },
      transactionContext: { transaction: 'mock' },
      forUpdate: true,
      includeUnpublished: true,
    });
    expect(revisionService.insertRevision).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 970001, revisionNo: 3, actorAccountId: 900001 }),
      { transaction: 'mock' },
    );
    expect(revisionService.advanceCurrentRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevisionNo: 2,
        apply: expect.objectContaining({ markDeleted: true }),
      }),
      { transaction: 'mock' },
    );
    expect(auditService.appendDocumentEvent).not.toHaveBeenCalled();
  });

  it('管理员作为原作者删除：同事务补写 ADMIN_DELETE_DOCUMENT 关键记录（等级取账号当前事实）', async () => {
    const accountQuery = makeAccountQuery(1);
    const { usecase, auditService } = makeUsecase({ accountQuery });

    await expect(
      usecase.execute({
        session: session(['SUPER_ADMIN']),
        documentId: 970001,
        expectedVersion: 2,
      }),
    ).resolves.toEqual({ id: 970001 });
    expect(auditService.appendDocumentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'ADMIN_DELETE_DOCUMENT',
        actorAdminLevel: 1,
        targetDocumentId: 970001,
        organizationId: 910001,
        transactionContext: { transaction: 'mock' },
      }),
    );
  });

  it('expected_version 过期拒绝（VERSION_CONFLICT）：不写修订行、不推进、不写审计', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockResolvedValue(detailQueryResult({ effectiveRevisionNo: 5 }));
    const { usecase, revisionService, auditService } = makeUsecase({ queryService });

    await expect(
      usecase.execute({
        session: session(['ENGINEER']),
        documentId: 970001,
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.VERSION_CONFLICT });
    expect(revisionService.insertRevision).not.toHaveBeenCalled();
    expect(revisionService.advanceCurrentRevision).not.toHaveBeenCalled();
    expect(auditService.appendDocumentEvent).not.toHaveBeenCalled();
  });

  it('他人条目/不存在/已软删（AUTHOR 范围核验统一 NOT_FOUND）不触达写路径', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockRejectedValue(
      new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问'),
    );
    const { usecase, revisionService } = makeUsecase({ queryService });

    await expect(
      usecase.execute({
        session: session(['ENGINEER']),
        documentId: 970004,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.NOT_FOUND });
    expect(revisionService.advanceCurrentRevision).not.toHaveBeenCalled();
  });

  it('条件推进未命中（并发竞态）：统一 NOT_FOUND，无半写', async () => {
    const revisionService = makeRevisionService();
    revisionService.advanceCurrentRevision.mockResolvedValue('VERSION_CONFLICT');
    const { usecase, auditService } = makeUsecase({ revisionService });

    await expect(
      usecase.execute({
        session: session(['ENGINEER']),
        documentId: 970001,
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.NOT_FOUND });
    expect(auditService.appendDocumentEvent).not.toHaveBeenCalled();
  });

  it('CUSTOMER 拒绝；expected_version 负数/非整数拒绝，事务不开启', async () => {
    const { usecase, queryService, revisionService } = makeUsecase();

    await expect(
      usecase.execute({
        session: session(['CUSTOMER']),
        documentId: 970001,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    await expect(
      usecase.execute({
        session: session(['ENGINEER']),
        documentId: 970001,
        expectedVersion: -1,
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
    await expect(
      usecase.execute({
        session: session(['ENGINEER']),
        documentId: 970001,
        expectedVersion: 2.5,
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
    expect(queryService.findDetail).not.toHaveBeenCalled();
    expect(revisionService.insertRevision).not.toHaveBeenCalled();
  });

  it('首次删除（current_revision_no = 0）：expected_version 0 合法，审核推进到 v1', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockResolvedValue(
      detailQueryResult({ effectiveRevisionNo: 0, contentText: '原始正文' }),
    );
    const { usecase, revisionService } = makeUsecase({ queryService });

    await expect(
      usecase.execute({
        session: session(['ENGINEER']),
        documentId: 970001,
        expectedVersion: 0,
      }),
    ).resolves.toEqual({ id: 970001 });
    expect(revisionService.insertRevision).toHaveBeenCalledWith(
      expect.objectContaining({ revisionNo: 1 }),
      { transaction: 'mock' },
    );
    expect(revisionService.advanceCurrentRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevisionNo: 0,
        apply: expect.objectContaining({ markDeleted: true }),
      }),
      { transaction: 'mock' },
    );
    // effectiveRevisionNo = 0：不读修订行，删除前正文取自资料自身正文
    expect(queryService.findRevision).not.toHaveBeenCalled();
  });
});

describe('GetReferenceDocumentFileUsecase', () => {
  const makeStorage = () => ({
    save: jest.fn(),
    open: jest.fn(),
    delete: jest.fn(),
  });
  const makeUsecase = (
    overrides: {
      queryService?: ReturnType<typeof makeQueryService>;
      storage?: ReturnType<typeof makeStorage>;
      accountQueryService?: ReturnType<typeof makeAccountQueryService>;
      organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
    } = {},
  ) => {
    const queryService = overrides.queryService ?? makeQueryService();
    const storage = overrides.storage ?? makeStorage();
    const accountQueryService = overrides.accountQueryService ?? makeAccountQueryService();
    const organizationContextService =
      overrides.organizationContextService ?? makeOrganizationContextService();
    return {
      queryService,
      storage,
      accountQueryService,
      organizationContextService,
      usecase: new GetReferenceDocumentFileUsecase(
        queryService as unknown as ReferenceDocumentQueryService,
        accountQueryService as unknown as AccountQueryService,
        organizationContextService as unknown as TrustedOrganizationContextQueryService,
        storage,
      ),
    };
  };

  const fileDetail = detailQueryResult({
    contentText: null,
    originalFilename: '说明书.pdf',
    mimeType: 'application/pdf',
    storageReference: 'a1b2c3d4e5f60718293a4b5c6d7e8f90.pdf',
  });

  it('SUPER_ADMIN 与 ENGINEER 均可下载：返回展示文件名/MIME 与内容流载荷（不含路径）', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockResolvedValue(fileDetail);
    const storage = makeStorage();
    storage.open.mockResolvedValue(Readable.from([Buffer.from('pdf-bytes')]));
    const { usecase } = makeUsecase({ queryService, storage });

    for (const roles of [['SUPER_ADMIN'], ['ENGINEER']]) {
      await expect(
        usecase.execute({ session: session(roles), documentId: 970001 }),
      ).resolves.toMatchObject({
        documentId: 970001,
        originalFilename: '说明书.pdf',
        mimeType: 'application/pdf',
      });
    }
    expect(storage.open).toHaveBeenCalledWith(fileDetail.storageReference);
    // 缺等级管理员回落本公司口径（A-PR0 §2.1 + 读侧范围决议）：查询必带本组织范围
    expect(queryService.findDetail).toHaveBeenCalledWith({
      documentId: 970001,
      scope: { kind: 'ORGANIZATION', organizationId: 910001 },
    });
  });

  it('一级管理员（admin_level=1）跨公司下载：GLOBAL 范围不按组织过滤，无本人成员关系仍可读', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockResolvedValue(fileDetail);
    const storage = makeStorage();
    storage.open.mockResolvedValue(Readable.from([Buffer.from('pdf-bytes')]));
    const accountQueryService = makeAccountQueryService();
    accountQueryService.findAdminLevelByAccountId.mockResolvedValue(1);
    const organizationContextService = makeOrganizationContextService();
    organizationContextService.resolveForAccount.mockRejectedValue(
      new DomainError(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, '当前账号没有有效组织成员关系'),
    );
    const { usecase } = makeUsecase({
      queryService,
      storage,
      accountQueryService,
      organizationContextService,
    });

    await expect(
      usecase.execute({ session: session(['SUPER_ADMIN']), documentId: 970001 }),
    ).resolves.toMatchObject({ documentId: 970001, originalFilename: '说明书.pdf' });
    // 一级全公司（R057-01）：GLOBAL 范围，不按组织收窄
    expect(queryService.findDetail).toHaveBeenCalledWith({
      documentId: 970001,
      scope: { kind: 'GLOBAL' },
    });
  });

  it('CUSTOMER 拒绝下载（0910 裁定收窄，与 GraphQL 读口径一致）', async () => {
    const { usecase } = makeUsecase();

    await expect(
      usecase.execute({ session: session(['CUSTOMER']), documentId: 970001 }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
  });

  it('空角色会话拒绝（匿名会话不允许下载）', async () => {
    const { usecase } = makeUsecase();

    await expect(
      usecase.execute({ session: session([]), documentId: 970001 }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
  });

  it('纯文本资料（无存储引用）FILE_NOT_AVAILABLE；不触达存储层', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockResolvedValue(detailQueryResult());
    const storage = makeStorage();
    const { usecase } = makeUsecase({ queryService, storage });

    await expect(
      usecase.execute({ session: session(['ENGINEER']), documentId: 970001 }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.FILE_NOT_AVAILABLE });
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('存储引用非法（open 抛错）收敛为 FILE_NOT_AVAILABLE，不返回路径', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockResolvedValue(fileDetail);
    const storage = makeStorage();
    storage.open.mockRejectedValue(new Error('Rejected invalid storage reference format'));
    const { usecase } = makeUsecase({ queryService, storage });

    await expect(
      usecase.execute({ session: session(['ENGINEER']), documentId: 970001 }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.FILE_NOT_AVAILABLE });
  });

  it('存储对象缺失（文件不存在）收敛为 FILE_NOT_AVAILABLE（受控错误，不泄漏路径）', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockResolvedValue(fileDetail);
    const storage = makeStorage();
    storage.open.mockRejectedValue(new Error('ENOENT: no such file or directory'));
    const { usecase } = makeUsecase({ queryService, storage });

    await expect(
      usecase.execute({ session: session(['ENGINEER']), documentId: 970001 }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.FILE_NOT_AVAILABLE });
  });

  it('无有效组织成员关系拒绝（下载前同组织事实核验）：不触达资料查询与存储层', async () => {
    const queryService = makeQueryService();
    const storage = makeStorage();
    const { usecase, organizationContextService } = makeUsecase({ queryService, storage });
    organizationContextService.resolveForAccount.mockRejectedValue(
      new DomainError(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, '当前账号没有有效组织成员关系'),
    );

    await expect(
      usecase.execute({ session: session(['ENGINEER']), documentId: 970001 }),
    ).rejects.toMatchObject({ code: ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP });
    expect(queryService.findDetail).not.toHaveBeenCalled();
    expect(storage.open).not.toHaveBeenCalled();
  });
});

describe('UpdateReferenceDocumentCaseUsecase', () => {
  const caseDetailView = (overrides: Record<string, unknown> = {}) => ({
    errorCode: 'ERR-1001',
    handlingStatus: 'UNRESOLVED',
    phenomenon: '曝光异常',
    conditionText: null,
    reproductionSteps: '1. 上料\n2. 启动',
    diagnosis: null,
    actionTaken: null,
    resolution: null,
    ...overrides,
  });

  const caseDetailResult = (caseDetailOverrides: Record<string, unknown> = {}) =>
    detailQueryResult({
      documentType: 'FAULT_CASE',
      caseDetail: caseDetailView(caseDetailOverrides),
    });

  const makeUsecase = (
    overrides: {
      writeService?: ReturnType<typeof makeWriteService>;
      caseDetailService?: ReturnType<typeof makeCaseDetailService>;
      queryService?: ReturnType<typeof makeQueryService>;
      modelQueryService?: ReturnType<typeof makeModelQueryService>;
    } = {},
  ) => {
    const writeService = overrides.writeService ?? makeWriteService();
    const caseDetailService = overrides.caseDetailService ?? makeCaseDetailService();
    const queryService = overrides.queryService ?? makeQueryService();
    if (!overrides.queryService) {
      queryService.findDetail.mockResolvedValue(caseDetailResult());
    }
    const modelQueryService = overrides.modelQueryService ?? makeModelQueryService();
    const organizationContextService = makeOrganizationContextService();
    const usecase = new UpdateReferenceDocumentCaseUsecase(
      writeService as unknown as ReferenceDocumentService,
      caseDetailService as unknown as ReferenceDocumentCaseDetailService,
      queryService as unknown as ReferenceDocumentQueryService,
      modelQueryService as unknown as EquipmentModelQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      makeTransactionRunner(),
    );
    return {
      writeService,
      caseDetailService,
      queryService,
      modelQueryService,
      organizationContextService,
      usecase,
    };
  };

  it('更正闭环（未解决→已解决且有结果）：明细全量覆盖、正文按同一真源重新生成、修改人落库、返回 ID/更新时间', async () => {
    const { usecase, writeService, caseDetailService, queryService, organizationContextService } =
      makeUsecase();
    const updatedAt = new Date('2026-10-20T08:30:00.000Z');
    queryService.findDetail.mockResolvedValueOnce(caseDetailResult()).mockResolvedValueOnce({
      ...caseDetailResult({ handlingStatus: 'RESOLVED', resolution: '更换光源模组后恢复正常' }),
      updatedAt,
    });

    await expect(
      usecase.execute({
        session: session(['SUPER_ADMIN']),
        documentId: 970001,
        patch: { handlingStatus: 'RESOLVED', resolution: '更换光源模组后恢复正常' },
      }),
    ).resolves.toEqual({ id: 970001, updatedAt });

    // 组织与当前值均在事务内解析（与读-改-写同快照）；更正后在同一范围回读真实状态
    expect(organizationContextService.resolveForAccount).toHaveBeenCalledWith({
      accountId: 900001,
      transactionContext: { transaction: 'mock' },
    });
    expect(queryService.findDetail).toHaveBeenCalledTimes(2);
    // 第 1 个调用（合并读）走锁定读（G2/F01）：与通用编辑共享同一行锁互斥
    expect(queryService.findDetail).toHaveBeenNthCalledWith(1, {
      documentId: 970001,
      scope: { kind: 'ORGANIZATION', organizationId: 910001 },
      transactionContext: { transaction: 'mock' },
      forUpdate: true,
      includeUnpublished: true,
    });
    // 第 2 个调用为事务内回读（锁已保持，不重复加锁）
    expect(queryService.findDetail).toHaveBeenNthCalledWith(2, {
      documentId: 970001,
      scope: { kind: 'ORGANIZATION', organizationId: 910001 },
      transactionContext: { transaction: 'mock' },
      includeUnpublished: true,
    });

    // 主资料：类型/标题/机型/说明保持，修改人落库；正文由合并后明细重新生成（禁止与明细脱节直改）
    const updatePayload = writeService.updateDocument.mock.calls[0][0] as {
      contentText: string;
    };
    expect(writeService.updateDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 970001,
        title: '错误码手册',
        documentType: 'FAULT_CASE',
        equipmentModelId: null,
        equipmentModelText: null,
        description: '说明',
        updatedByAccountId: 900001,
        contentText: updatePayload.contentText,
      }),
      { transaction: 'mock' },
    );
    expect(updatePayload.contentText).toContain('错误码：ERR-1001');
    expect(updatePayload.contentText).toContain('故障现象：\n曝光异常');
    expect(updatePayload.contentText).toContain('复现步骤：\n1. 上料\n2. 启动');
    expect(updatePayload.contentText).toContain('处理状态：已解决');
    expect(updatePayload.contentText).toContain('处理结果：\n更换光源模组后恢复正常');

    // 明细全量覆盖：未提供字段保持当前值，处理状态与处理结果落新值
    expect(caseDetailService.updateCaseDetail).toHaveBeenCalledWith(
      {
        documentId: 970001,
        errorCode: 'ERR-1001',
        handlingStatus: 'RESOLVED',
        phenomenon: '曝光异常',
        conditionText: null,
        reproductionSteps: '1. 上料\n2. 启动',
        diagnosis: null,
        actionTaken: null,
        resolution: '更换光源模组后恢复正常',
      },
      { transaction: 'mock' },
    );
  });

  it('部分提交合并：仅提交处理状态时其余字段保持；显式 null 清空可选字段且正文同步省略对应段', async () => {
    const { usecase, writeService, caseDetailService, queryService } = makeUsecase();

    await usecase.execute({
      session: session(['SUPER_ADMIN']),
      documentId: 970001,
      patch: { handlingStatus: 'IN_PROGRESS' },
    });
    expect(caseDetailService.updateCaseDetail).toHaveBeenLastCalledWith(
      expect.objectContaining({
        errorCode: 'ERR-1001',
        handlingStatus: 'IN_PROGRESS',
        phenomenon: '曝光异常',
        reproductionSteps: '1. 上料\n2. 启动',
      }),
      expect.anything(),
    );
    const inProgressContent = (
      writeService.updateDocument.mock.calls[0][0] as { contentText: string }
    ).contentText;
    expect(inProgressContent).toContain('处理状态：处理中');
    expect(inProgressContent).not.toContain('处理结果：');

    // 模拟第一次更正已落库：第二次执行读取到 IN_PROGRESS
    queryService.findDetail.mockResolvedValue(caseDetailResult({ handlingStatus: 'IN_PROGRESS' }));
    await usecase.execute({
      session: session(['SUPER_ADMIN']),
      documentId: 970001,
      patch: { errorCode: null, conditionText: null, diagnosis: null, actionTaken: null },
    });
    expect(caseDetailService.updateCaseDetail).toHaveBeenLastCalledWith(
      expect.objectContaining({
        errorCode: null,
        handlingStatus: 'IN_PROGRESS',
        phenomenon: '曝光异常',
        conditionText: null,
        reproductionSteps: '1. 上料\n2. 启动',
        diagnosis: null,
        actionTaken: null,
        resolution: null,
      }),
      expect.anything(),
    );
    const clearedContent = (writeService.updateDocument.mock.calls[1][0] as { contentText: string })
      .contentText;
    expect(clearedContent).not.toContain('错误码：');
    expect(clearedContent).not.toContain('触发条件：');
    expect(clearedContent).not.toContain('排查过程：');
    expect(clearedContent).not.toContain('处理措施：');
    expect(clearedContent).not.toContain('处理结果：');
    expect(clearedContent).toContain('故障现象：\n曝光异常');
    expect(clearedContent).toContain('复现步骤：\n1. 上料\n2. 启动');
  });

  it('最终态校验拒绝：已解决缺处理结果、必填字段置空、空补丁、状态值域外取值（均不进入写路径）', async () => {
    const { usecase, writeService, caseDetailService } = makeUsecase();

    // 已解决必须有处理结果（chk_reference_document_case_detail_resolution 同口径）
    await expect(
      usecase.execute({
        session: session(['SUPER_ADMIN']),
        documentId: 970001,
        patch: { handlingStatus: 'RESOLVED' },
      }),
    ).rejects.toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
      message: '处理状态为已解决时必须填写处理结果',
    });

    // 必填字段（标题/现象/复现步骤/处理状态）合并后置空拒绝（含空白清洗为空的场景）
    await expect(
      usecase.execute({
        session: session(['SUPER_ADMIN']),
        documentId: 970001,
        patch: { title: '   ' },
      }),
    ).rejects.toMatchObject({ message: '更正后的案例标题不能为空' });
    await expect(
      usecase.execute({
        session: session(['SUPER_ADMIN']),
        documentId: 970001,
        patch: { phenomenon: null },
      }),
    ).rejects.toMatchObject({ message: '更正后的案例故障现象不能为空' });
    await expect(
      usecase.execute({
        session: session(['SUPER_ADMIN']),
        documentId: 970001,
        patch: { reproductionSteps: null },
      }),
    ).rejects.toMatchObject({ message: '更正后的案例复现步骤不能为空' });
    await expect(
      usecase.execute({
        session: session(['SUPER_ADMIN']),
        documentId: 970001,
        patch: { handlingStatus: null },
      }),
    ).rejects.toMatchObject({ message: '更正后的案例处理状态不能为空' });

    // 空补丁（全 undefined）与处理状态受控值域外取值拒绝
    await expect(
      usecase.execute({ session: session(['SUPER_ADMIN']), documentId: 970001, patch: {} }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
    await expect(
      usecase.execute({
        session: session(['SUPER_ADMIN']),
        documentId: 970001,
        patch: { handlingStatus: 'CLOSED' },
      }),
    ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_ENUM_VALUE });

    expect(writeService.updateDocument).not.toHaveBeenCalled();
    expect(caseDetailService.updateCaseDetail).not.toHaveBeenCalled();
  });

  it('ENGINEER/客户/匿名拒绝；非案例目标与案例明细缺失拒绝（均不进入写路径）', async () => {
    const { usecase, writeService, caseDetailService } = makeUsecase();

    // 专属更正仅管理员（精确角色口径，与通用编辑一致）
    for (const roles of [['ENGINEER'], ['CUSTOMER'], []]) {
      await expect(
        usecase.execute({ session: session(roles), documentId: 970001, patch: { title: 'x' } }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    }

    // 非 FAULT_CASE 目标：普通资料必须走通用编辑接口
    const manualQuery = makeQueryService();
    manualQuery.findDetail.mockResolvedValue(
      detailQueryResult({ documentType: 'ERROR_CODE_MANUAL' }),
    );
    const manual = makeUsecase({ queryService: manualQuery });
    await expect(
      manual.usecase.execute({
        session: session(['SUPER_ADMIN']),
        documentId: 970001,
        patch: { title: 'x' },
      }),
    ).rejects.toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
      message: '仅故障案例资料可以使用案例更正接口',
    });

    // 案例类型与明细一一对应：明细缺失属定式破坏，失败关闭
    const brokenQuery = makeQueryService();
    brokenQuery.findDetail.mockResolvedValue(
      detailQueryResult({ documentType: 'FAULT_CASE', caseDetail: null }),
    );
    const broken = makeUsecase({ queryService: brokenQuery });
    await expect(
      broken.usecase.execute({
        session: session(['SUPER_ADMIN']),
        documentId: 970001,
        patch: { title: 'x' },
      }),
    ).rejects.toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.UPDATE_FAILED,
      message: '案例明细缺失，无法完成更正',
    });

    // 大小写变体目标（'fault_case'）按不敏感判定等价案例：门禁放行到明细检查，
    // 明细缺失时同样失败关闭（变体不构成绕过门禁/漏判保护的缝隙）
    const variantQuery = makeQueryService();
    variantQuery.findDetail.mockResolvedValue(
      detailQueryResult({ documentType: 'fault_case', caseDetail: null }),
    );
    const variant = makeUsecase({ queryService: variantQuery });
    await expect(
      variant.usecase.execute({
        session: session(['SUPER_ADMIN']),
        documentId: 970001,
        patch: { title: 'x' },
      }),
    ).rejects.toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.UPDATE_FAILED,
      message: '案例明细缺失，无法完成更正',
    });

    expect(writeService.updateDocument).not.toHaveBeenCalled();
    expect(caseDetailService.updateCaseDetail).not.toHaveBeenCalled();
    expect(manual.writeService.updateDocument).not.toHaveBeenCalled();
    expect(broken.writeService.updateDocument).not.toHaveBeenCalled();
    expect(variant.writeService.updateDocument).not.toHaveBeenCalled();
  });

  it('目标不存在/已软删/跨组织（QueryService 统一 NOT_FOUND）与无组织成员关系（均不进入写路径）', async () => {
    const queryService = makeQueryService();
    queryService.findDetail.mockRejectedValue(
      new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问', {
        id: 970004,
      }),
    );
    const { usecase, writeService, caseDetailService } = makeUsecase({ queryService });

    await expect(
      usecase.execute({
        session: session(['SUPER_ADMIN']),
        documentId: 970004,
        patch: { title: 'x' },
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.NOT_FOUND });
    expect(writeService.updateDocument).not.toHaveBeenCalled();
    expect(caseDetailService.updateCaseDetail).not.toHaveBeenCalled();

    const noMembership = makeUsecase();
    noMembership.organizationContextService.resolveForAccount.mockRejectedValue(
      new DomainError(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, '当前账号没有有效组织成员关系'),
    );
    await expect(
      noMembership.usecase.execute({
        session: session(['SUPER_ADMIN']),
        documentId: 970001,
        patch: { title: 'x' },
      }),
    ).rejects.toMatchObject({ code: ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP });
    expect(noMembership.queryService.findDetail).not.toHaveBeenCalled();
    expect(noMembership.writeService.updateDocument).not.toHaveBeenCalled();
  });

  it('机型合并：未变更现值不重复查询、显式清空、机型文字→机型 ID 同一补丁替换', async () => {
    // 现值已设 ID 且补丁原样提交：受外键保护不重复查询
    const keepQuery = makeQueryService();
    keepQuery.findDetail.mockResolvedValue(
      detailQueryResult({
        documentType: 'FAULT_CASE',
        caseDetail: caseDetailView(),
        equipmentModelId: 930001,
      }),
    );
    const keep = makeUsecase({ queryService: keepQuery });
    await expect(
      keep.usecase.execute({
        session: session(['SUPER_ADMIN']),
        documentId: 970001,
        patch: { equipmentModelId: 930001 },
      }),
    ).resolves.toMatchObject({ id: 970001 });
    expect(keep.modelQueryService.findModelById).not.toHaveBeenCalled();
    expect(keep.writeService.updateDocument).toHaveBeenCalledWith(
      expect.objectContaining({ equipmentModelId: 930001, equipmentModelText: null }),
      expect.anything(),
    );

    // 显式清空机型 ID：合并后两侧均为空（通用案例合法）
    const clear = makeUsecase({ queryService: keepQuery });
    await expect(
      clear.usecase.execute({
        session: session(['SUPER_ADMIN']),
        documentId: 970001,
        patch: { equipmentModelId: null },
      }),
    ).resolves.toMatchObject({ id: 970001 });
    expect(clear.writeService.updateDocument).toHaveBeenCalledWith(
      expect.objectContaining({ equipmentModelId: null, equipmentModelText: null }),
      expect.anything(),
    );

    // 机型文字 → 机型 ID：同一补丁「清空一侧 + 设置另一侧」，互斥按合并后最终态判定
    const switchQuery = makeQueryService();
    switchQuery.findDetail.mockResolvedValue(
      detailQueryResult({
        documentType: 'FAULT_CASE',
        caseDetail: caseDetailView(),
        equipmentModelText: '手填机型 XYZ',
      }),
    );
    const switched = makeUsecase({ queryService: switchQuery });
    await expect(
      switched.usecase.execute({
        session: session(['SUPER_ADMIN']),
        documentId: 970001,
        patch: { equipmentModelText: null, equipmentModelId: 930001 },
      }),
    ).resolves.toMatchObject({ id: 970001 });
    expect(switched.modelQueryService.findModelById).toHaveBeenCalledWith({
      id: 930001,
      transactionContext: { transaction: 'mock' },
    });
    expect(switched.writeService.updateDocument).toHaveBeenCalledWith(
      expect.objectContaining({ equipmentModelId: 930001, equipmentModelText: null }),
      expect.anything(),
    );
  });

  it('机型防御：非法 ID、变更时型号不存在、合并后互斥（均不进入写路径）', async () => {
    // 非法 ID（非正整数）输入校验拒绝
    const invalidId = makeUsecase();
    await expect(
      invalidId.usecase.execute({
        session: session(['SUPER_ADMIN']),
        documentId: 970001,
        patch: { equipmentModelId: 0 },
      }),
    ).rejects.toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
      message: '设备型号 ID 无效',
    });

    // 变更值才查询型号：不存在即拒绝
    const modelQueryService = makeModelQueryService();
    modelQueryService.findModelById.mockResolvedValue(null);
    const missingModel = makeUsecase({ modelQueryService });
    await expect(
      missingModel.usecase.execute({
        session: session(['SUPER_ADMIN']),
        documentId: 970001,
        patch: { equipmentModelId: 930099 },
      }),
    ).rejects.toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.EQUIPMENT_MODEL_NOT_FOUND,
      message: '设备型号不存在',
    });

    // 已有机型文字的资料直接设置机型 ID：合并后互斥拒绝并给出替换指引
    const exclusiveQuery = makeQueryService();
    exclusiveQuery.findDetail.mockResolvedValue(
      detailQueryResult({
        documentType: 'FAULT_CASE',
        caseDetail: caseDetailView(),
        equipmentModelText: '手填机型 XYZ',
      }),
    );
    const exclusive = makeUsecase({ queryService: exclusiveQuery });
    await expect(
      exclusive.usecase.execute({
        session: session(['SUPER_ADMIN']),
        documentId: 970001,
        patch: { equipmentModelId: 930001 },
      }),
    ).rejects.toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
      message: '机型 ID 与机型文字只能设置一个（两者互斥）；替换机型请在同一补丁中清空另一侧',
    });

    for (const blocked of [invalidId, missingModel, exclusive]) {
      expect(blocked.writeService.updateDocument).not.toHaveBeenCalled();
      expect(blocked.caseDetailService.updateCaseDetail).not.toHaveBeenCalled();
    }
  });
});
