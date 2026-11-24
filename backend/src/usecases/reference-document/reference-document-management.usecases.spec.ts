// src/usecases/reference-document/reference-document-management.usecases.spec.ts
// 任务 07 资料管理操作定向测试（R053/R058–R061）：
// 一级管理员权限、expected_version 并发、状态白名单、正文不回退、
// 关键审计同事务写入与失败回滚（无半写）。

/// <reference types="jest" />

import type { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  DomainError,
  PERMISSION_ERROR,
  REFERENCE_DOCUMENT_ERROR,
} from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { ManagementAuditService } from '@src/modules/lithography/management-audit.service';
import type { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import type { ReferenceDocumentRevisionService } from '@src/modules/lithography/reference-document-revision.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { AdminDeleteReferenceDocumentUsecase } from './admin-delete-reference-document.usecase';
import { CorrectReferenceDocumentOwnershipUsecase } from './correct-reference-document-ownership.usecase';
import { OfflineReferenceDocumentUsecase } from './offline-reference-document.usecase';
import { ReviseReferenceDocumentUsecase } from './revise-reference-document.usecase';

const TX = { transaction: 'mock' };

const firstLevelSession = {
  accountId: 900001,
  roles: ['SUPER_ADMIN', 'ENGINEER'],
  activeRole: 'SUPER_ADMIN',
} as unknown as UsecaseSession;

const secondLevelSession = {
  accountId: 900002,
  roles: ['SUPER_ADMIN'],
  activeRole: 'SUPER_ADMIN',
} as unknown as UsecaseSession;

const engineerSession = {
  accountId: 900003,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as unknown as UsecaseSession;

/** 统一夹具：一级管理员等级事实 = 1；详情为 ONLINE + CONFIRMED 普通资料 */
const makeDetail = (overrides: Record<string, unknown> = {}) => ({
  id: 970001,
  title: '错误码手册',
  documentType: 'ERROR_CODE_MANUAL',
  equipmentModelId: null,
  equipmentModelName: null,
  equipmentModelText: null,
  description: '说明',
  originalFilename: null,
  mimeType: null,
  contentText: '正文（旧）',
  organizationName: '甲方默认组织',
  ingestMethod: 'ADMIN_DIRECT',
  sourceKind: 'MATERIAL',
  sourceReportId: null,
  sourceReportVersionId: null,
  publicationStatus: 'ONLINE',
  ownershipStatus: 'CONFIRMED',
  effectiveRevisionNo: 2,
  schemaVersion: 1,
  ownerOrganizationId: 910001,
  caseDetail: null,
  storageReference: null,
  createdByAccountId: 900003,
  createdAt: new Date('2026-01-02T10:00:00.000Z'),
  updatedAt: new Date('2026-01-02T10:00:00.000Z'),
  ...overrides,
});

const makeHarness = (
  params: { detail?: Record<string, unknown>; adminLevel?: number | null } = {},
) => {
  const queryService = {
    findDetail: jest.fn().mockResolvedValue(makeDetail(params.detail)),
    // 生效修订读替身：修订号 > 0 时返回当时生效正文快照（缺失行才视为数据定式破坏）
    findRevision: jest
      .fn()
      .mockImplementation((_documentId: number, revisionNo: number) =>
        Promise.resolve(
          revisionNo > 0
            ? { revisionNo, afterSnapshot: { schema_version: 1, contentText: '正文（旧）' } }
            : null,
        ),
      ),
  };
  const maintenanceReports = { readVersionById: jest.fn().mockResolvedValue(null) };
  const revisionService = {
    insertRevision: jest.fn().mockResolvedValue(undefined),
    advanceCurrentRevision: jest.fn().mockResolvedValue('ADVANCED'),
  };
  const auditService = { appendDocumentEvent: jest.fn().mockResolvedValue(undefined) };
  const accountQueryService = {
    findAdminLevelByAccountId: jest
      .fn()
      .mockResolvedValue(params.adminLevel !== undefined ? params.adminLevel : 1),
    findAccountSnapshotById: jest.fn().mockResolvedValue({ id: 900009, nickname: '真实上传者' }),
  };
  const organizationQueryService = {
    findOrganizationNameById: jest.fn().mockResolvedValue('真实公司'),
  };
  const transactionRunner = {
    run: jest.fn((cb: (ctx: unknown) => unknown) => cb(TX)),
  } as unknown as TransactionRunner & { run: jest.Mock };

  const revise = new ReviseReferenceDocumentUsecase(
    queryService as unknown as ReferenceDocumentQueryService,
    {
      assertBusinessWritable: () => Promise.resolve(),
      assertBusinessWritableInTransaction: () => Promise.resolve(),
      assertCompanyWritable: () => Promise.resolve(),
      assertCompanyWritableInTransaction: () => Promise.resolve(),
      assertWritable: () => Promise.resolve(),
    } as unknown as LocalWriteHoldService,
    maintenanceReports as unknown as MaintenanceReportQueryService,
    revisionService as unknown as ReferenceDocumentRevisionService,
    accountQueryService as unknown as AccountQueryService,
    transactionRunner,
  );
  const offline = new OfflineReferenceDocumentUsecase(
    queryService as unknown as ReferenceDocumentQueryService,
    {
      assertBusinessWritable: () => Promise.resolve(),
      assertBusinessWritableInTransaction: () => Promise.resolve(),
      assertCompanyWritable: () => Promise.resolve(),
      assertCompanyWritableInTransaction: () => Promise.resolve(),
      assertWritable: () => Promise.resolve(),
    } as unknown as LocalWriteHoldService,
    maintenanceReports as unknown as MaintenanceReportQueryService,
    revisionService as unknown as ReferenceDocumentRevisionService,
    accountQueryService as unknown as AccountQueryService,
    transactionRunner,
  );
  const adminDelete = new AdminDeleteReferenceDocumentUsecase(
    queryService as unknown as ReferenceDocumentQueryService,
    {
      assertBusinessWritable: () => Promise.resolve(),
      assertBusinessWritableInTransaction: () => Promise.resolve(),
      assertCompanyWritable: () => Promise.resolve(),
      assertCompanyWritableInTransaction: () => Promise.resolve(),
      assertWritable: () => Promise.resolve(),
    } as unknown as LocalWriteHoldService,
    maintenanceReports as unknown as MaintenanceReportQueryService,
    revisionService as unknown as ReferenceDocumentRevisionService,
    auditService as unknown as ManagementAuditService,
    accountQueryService as unknown as AccountQueryService,
    transactionRunner,
  );
  const correctOwnership = new CorrectReferenceDocumentOwnershipUsecase(
    queryService as unknown as ReferenceDocumentQueryService,
    {
      assertBusinessWritable: () => Promise.resolve(),
      assertBusinessWritableInTransaction: () => Promise.resolve(),
      assertCompanyWritable: () => Promise.resolve(),
      assertCompanyWritableInTransaction: () => Promise.resolve(),
      assertWritable: () => Promise.resolve(),
    } as unknown as LocalWriteHoldService,
    maintenanceReports as unknown as MaintenanceReportQueryService,
    revisionService as unknown as ReferenceDocumentRevisionService,
    auditService as unknown as ManagementAuditService,
    accountQueryService as unknown as AccountQueryService,
    organizationQueryService as unknown as OrganizationQueryService,
    transactionRunner,
  );

  return {
    queryService,
    revisionService,
    auditService,
    accountQueryService,
    organizationQueryService,
    transactionRunner,
    revise,
    offline,
    adminDelete,
    correctOwnership,
  };
};

describe('资料管理操作 · 角色（R058–R061：仅一级管理员）', () => {
  it.each([
    ['二级管理员', secondLevelSession],
    ['工程师', engineerSession],
  ])(
    '%s 执行修订/下架/管理删除/归属更正一律权限拒绝，等级读取后失败关闭',
    async (_label, session) => {
      const h = makeHarness({ adminLevel: 2 });

      await expect(
        h.revise.execute({
          session,
          documentId: 970001,
          expectedVersion: 2,
          reason: 'r',
          patch: { title: 'x' },
        }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
      await expect(
        h.offline.execute({ session, documentId: 970001, expectedVersion: 2, reason: 'r' }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
      await expect(
        h.adminDelete.execute({ session, documentId: 970001, expectedVersion: 2, reason: 'r' }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
      await expect(
        h.correctOwnership.execute({
          session,
          documentId: 970001,
          expectedVersion: 2,
          verificationReason: 'r',
          ownerOrganizationId: 910001,
        }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
      expect(h.queryService.findDetail).not.toHaveBeenCalled();
      expect(h.revisionService.advanceCurrentRevision).not.toHaveBeenCalled();
    },
  );

  it('账号等级事实缺失（null）的一级候选失败关闭：不进入资源读取', async () => {
    const h = makeHarness({ adminLevel: null });

    await expect(
      h.offline.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 2,
        reason: 'r',
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(h.queryService.findDetail).not.toHaveBeenCalled();
  });
});

describe('ReviseReferenceDocumentUsecase（R058 管理修订）', () => {
  it('修订正文：锁定读 + 版本核对 + 修订行（新版本号 = expected+1）+ 条件推进携带新正文', async () => {
    const h = makeHarness();

    await expect(
      h.revise.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 2,
        reason: '勘误',
        patch: { contentText: '正文（新）' },
      }),
    ).resolves.toEqual({ id: 970001, revisionNo: 3 });
    expect(h.queryService.findDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 970001,
        scope: { kind: 'GLOBAL' },
        forUpdate: true,
        transactionContext: TX,
      }),
    );
    expect(h.revisionService.insertRevision).toHaveBeenCalledWith(
      expect.objectContaining({ revisionNo: 3, actorAccountId: 900001, reason: '勘误' }),
      TX,
    );
    const inserted = h.revisionService.insertRevision.mock.calls[0][0] as {
      beforeSnapshot: string;
      afterSnapshot: string;
    };
    expect(JSON.parse(inserted.beforeSnapshot)).toMatchObject({
      schema_version: 1,
      contentText: '正文（旧）',
    });
    expect(JSON.parse(inserted.afterSnapshot)).toMatchObject({
      schema_version: 1,
      contentText: '正文（新）',
    });
    expect(h.revisionService.advanceCurrentRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevisionNo: 2,
        apply: expect.objectContaining({ contentText: '正文（新）', updatedByAccountId: 900001 }),
      }),
      TX,
    );
  });

  it('expected_version 过期拒绝（VERSION_CONFLICT）：不写修订行、不推进', async () => {
    const h = makeHarness({ detail: { effectiveRevisionNo: 5 } });

    await expect(
      h.revise.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 2,
        reason: 'r',
        patch: { title: 'x' },
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.VERSION_CONFLICT });
    expect(h.revisionService.insertRevision).not.toHaveBeenCalled();
  });

  it('FAULT_CASE 正文保护：管理修订不得拆开案例明细耦合（须走案例更正接口）', async () => {
    const h = makeHarness({ detail: { documentType: 'FAULT_CASE' } });

    await expect(
      h.revise.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 2,
        reason: 'r',
        patch: { contentText: 'x' },
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
    expect(h.revisionService.advanceCurrentRevision).not.toHaveBeenCalled();
  });

  it('条件推进未命中（并发竞态）：VERSION_CONFLICT，修订行随事务回滚，无半写', async () => {
    const h = makeHarness();
    h.revisionService.advanceCurrentRevision.mockResolvedValue('VERSION_CONFLICT');

    await expect(
      h.revise.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 2,
        reason: 'r',
        patch: { title: 'x' },
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.VERSION_CONFLICT });
  });

  it('原因必填；补丁至少一个字段；无存储引用资料正文清空拒绝（双空防御）', async () => {
    const h = makeHarness();

    await expect(
      h.revise.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 2,
        reason: '   ',
        patch: { title: 'x' },
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
    await expect(
      h.revise.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 2,
        reason: 'r',
        patch: {},
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
    await expect(
      h.revise.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 2,
        reason: 'r',
        patch: { contentText: null },
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.CONTENT_SOURCE_EMPTY });
    expect(h.revisionService.advanceCurrentRevision).not.toHaveBeenCalled();
  });
});

describe('OfflineReferenceDocumentUsecase（R059 下架）', () => {
  it('下架：OFFLINE 推进 + 业务历史快照继承生效正文；不写三类关键审计', async () => {
    const h = makeHarness();

    await expect(
      h.offline.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 2,
        reason: '重复条目',
      }),
    ).resolves.toEqual({ id: 970001, revisionNo: 3 });
    const inserted = h.revisionService.insertRevision.mock.calls[0][0] as {
      afterSnapshot: string;
    };
    expect(JSON.parse(inserted.afterSnapshot)).toMatchObject({
      contentText: '正文（旧）',
      publicationStatus: 'OFFLINE',
    });
    expect(h.revisionService.advanceCurrentRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        apply: expect.objectContaining({ publicationStatus: 'OFFLINE' }),
      }),
      TX,
    );
    expect(h.auditService.appendDocumentEvent).not.toHaveBeenCalled();
  });
});

describe('AdminDeleteReferenceDocumentUsecase（R060 管理删除）', () => {
  it('管理删除：软删（markDeleted）+ 修订历史 + ADMIN_DELETE_DOCUMENT 审计同事务写入', async () => {
    const h = makeHarness();

    await expect(
      h.adminDelete.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 2,
        reason: '违规内容',
      }),
    ).resolves.toEqual({ id: 970001, revisionNo: 3 });
    expect(h.revisionService.advanceCurrentRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevisionNo: 2,
        apply: expect.objectContaining({ markDeleted: true }),
      }),
      TX,
    );
    expect(h.auditService.appendDocumentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'ADMIN_DELETE_DOCUMENT',
        targetDocumentId: 970001,
        organizationId: 910001,
        actorAdminLevel: 1,
        reason: '违规内容',
        transactionContext: TX,
      }),
    );
  });

  it('审计写入失败时整事务回滚，不返回成功', async () => {
    const h = makeHarness();
    h.auditService.appendDocumentEvent.mockRejectedValue(new Error('audit insert failed'));

    await expect(
      h.adminDelete.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 2,
        reason: 'r',
      }),
    ).rejects.toThrow('audit insert failed');
  });
});

describe('CorrectReferenceDocumentOwnershipUsecase（R061-02 归属更正）', () => {
  it('单项更正上传者：仅更新显式字段、保留原核实状态，关键审计记录字段级前后值', async () => {
    const h = makeHarness({ detail: { ownershipStatus: 'PENDING', ownerOrganizationId: null } });

    await expect(
      h.correctOwnership.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 2,
        verificationReason: '核实为原公司同事上传',
        createdByAccountId: 900009,
      }),
    ).resolves.toEqual({ id: 970001, revisionNo: 3 });
    expect(h.revisionService.advanceCurrentRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        apply: expect.not.objectContaining({ ownerOrganizationId: expect.anything() }),
      }),
      TX,
    );
    expect(h.auditService.appendDocumentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'CORRECT_DOCUMENT_OWNERSHIP',
        changes: { createdByAccountId: { from: 900003, to: 900009 } },
        transactionContext: TX,
      }),
    );
  });

  it('两项均显式更正时依据核实证据置 CONFIRMED；组织事实校验失败拒绝', async () => {
    const h = makeHarness();
    h.organizationQueryService.findOrganizationNameById.mockResolvedValue(null);

    await expect(
      h.correctOwnership.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 2,
        verificationReason: 'r',
        createdByAccountId: 900009,
        ownerOrganizationId: 920001,
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });

    h.organizationQueryService.findOrganizationNameById.mockResolvedValue('真实公司');
    await expect(
      h.correctOwnership.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 2,
        verificationReason: '两项核实',
        createdByAccountId: 900009,
        ownerOrganizationId: 920001,
      }),
    ).resolves.toEqual({ id: 970001, revisionNo: 3 });
    expect(h.revisionService.advanceCurrentRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        apply: expect.objectContaining({ ownershipStatus: 'CONFIRMED' }),
      }),
      TX,
    );
  });

  it('未提交任何更正字段拒绝；上传者账号不存在拒绝', async () => {
    const h = makeHarness();
    h.accountQueryService.findAccountSnapshotById.mockResolvedValue(null);

    await expect(
      h.correctOwnership.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 2,
        verificationReason: 'r',
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
    await expect(
      h.correctOwnership.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 2,
        verificationReason: 'r',
        createdByAccountId: 900999,
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
    expect(h.revisionService.advanceCurrentRevision).not.toHaveBeenCalled();
  });

  it('expected_version 过期拒绝：版本过期须重新核对，不覆盖并发更正', async () => {
    const h = makeHarness({ detail: { effectiveRevisionNo: 4 } });

    await expect(
      h.correctOwnership.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 2,
        verificationReason: 'r',
        ownerOrganizationId: 920001,
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.VERSION_CONFLICT });
  });
});

describe('资料管理操作 · 输入与事务边界共性', () => {
  it('findDetail 抛出 NOT_FOUND（不存在/下架/已软删/跨范围）时无任何写入', async () => {
    const h = makeHarness();
    h.queryService.findDetail.mockRejectedValue(
      new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问'),
    );

    await expect(
      h.offline.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 2,
        reason: 'r',
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.NOT_FOUND });
    await expect(
      h.adminDelete.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 2,
        reason: 'r',
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.NOT_FOUND });
    expect(h.revisionService.insertRevision).not.toHaveBeenCalled();
    expect(h.auditService.appendDocumentEvent).not.toHaveBeenCalled();
  });

  it('documentId / expected_version 非法输入拒绝，事务不开启', async () => {
    const h = makeHarness();

    await expect(
      h.revise.execute({
        session: firstLevelSession,
        documentId: 0,
        expectedVersion: 2,
        reason: 'r',
        patch: { title: 'x' },
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
    await expect(
      h.adminDelete.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: -1,
        reason: 'r',
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
    await expect(
      h.offline.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 1.5,
        reason: 'r',
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS });
    expect(h.transactionRunner.run).not.toHaveBeenCalled();
    expect(h.queryService.findDetail).not.toHaveBeenCalled();
    expect(h.revisionService.insertRevision).not.toHaveBeenCalled();
    expect(h.revisionService.advanceCurrentRevision).not.toHaveBeenCalled();
  });
});

describe('首次管理操作 · expected_version = 0（current_revision_no 默认 0）', () => {
  // 口径依据：reference_document.current_revision_no 默认 0（仅原始冻结报告/正文，
  // 尚无管理修订），故存量与新建资料的第一次管理操作令牌合法为 0；
  // 生成的新生效版本必须是 1，且条件推进 WHERE 带上 current_revision_no = 0。

  it('管理修订 / 下架 / 管理删除 / 归属更正都接受 0，并生成 v1', async () => {
    const h = makeHarness({ detail: { effectiveRevisionNo: 0, contentText: '原始正文' } });

    await expect(
      h.revise.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 0,
        reason: '首次修订',
        patch: { contentText: '首次管理修订正文' },
      }),
    ).resolves.toEqual({ id: 970001, revisionNo: 1 });
    expect(h.revisionService.insertRevision).toHaveBeenCalledWith(
      expect.objectContaining({ revisionNo: 1, reason: '首次修订' }),
      TX,
    );
    expect(h.revisionService.advanceCurrentRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevisionNo: 0,
        apply: expect.objectContaining({ contentText: '首次管理修订正文' }),
      }),
      TX,
    );
    // effectiveRevisionNo = 0 不读修订行（当时正文即原始正文），before 快照取自资料正文
    const inserted = h.revisionService.insertRevision.mock.calls[0][0] as {
      beforeSnapshot: string;
    };
    expect(JSON.parse(inserted.beforeSnapshot)).toMatchObject({ contentText: '原始正文' });
    expect(h.queryService.findRevision).not.toHaveBeenCalled();

    await expect(
      h.offline.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 0,
        reason: '首次下架',
      }),
    ).resolves.toEqual({ id: 970001, revisionNo: 1 });

    await expect(
      h.adminDelete.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 0,
        reason: '首次管理删除',
      }),
    ).resolves.toEqual({ id: 970001, revisionNo: 1 });

    await expect(
      h.correctOwnership.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 0,
        verificationReason: '首次归属核实',
        ownerOrganizationId: 920001,
      }),
    ).resolves.toEqual({ id: 970001, revisionNo: 1 });
  });

  it('成功后当前版本变为 1：同一旧令牌 0 再次提交按版本过期拒绝，不覆盖', async () => {
    const h = makeHarness({ detail: { effectiveRevisionNo: 1 } });

    await expect(
      h.offline.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 0,
        reason: 'r',
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.VERSION_CONFLICT });
    expect(h.revisionService.insertRevision).not.toHaveBeenCalled();
    expect(h.revisionService.advanceCurrentRevision).not.toHaveBeenCalled();
  });

  it('版本 0 下条件推进未命中：VERSION_CONFLICT，修订行随事务回滚（无半写）', async () => {
    const h = makeHarness({ detail: { effectiveRevisionNo: 0 } });
    h.revisionService.advanceCurrentRevision.mockResolvedValue('VERSION_CONFLICT');

    await expect(
      h.revise.execute({
        session: firstLevelSession,
        documentId: 970001,
        expectedVersion: 0,
        reason: 'r',
        patch: { title: 'x' },
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.VERSION_CONFLICT });
  });
});
