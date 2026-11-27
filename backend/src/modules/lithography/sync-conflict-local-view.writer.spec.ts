/// <reference types="jest" />
import {
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import { SYNC_ERROR } from '@core/common/errors/domain-error';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type {
  SyncConflictLocalViewWriteCommand,
  SyncConflictLocalViewWriter,
} from '@usecases/common/ports/sync-conflict-local-view-writer.contract';
import { SyncConflictLocalViewWriterService } from './sync-conflict-local-view.writer';
import type { ReferenceDocumentEffectiveContentService } from './reference-document-effective-content.service';
import type {
  ReferenceDocumentRevisionService,
  ReferenceDocumentRevisionTargetSnapshot,
} from './reference-document-revision.service';
import type {
  RepairRequestRevisionService,
  RepairRequestRevisionTargetSnapshot,
} from './repair-request-revision.service';

/**
 * 「使用云端」的本地视图对齐写入（任务 09 R068）。
 *
 * 守住：
 * - 版本条件：命中条件才写，条件不成立即版本冲突；
 * - **历史只追加**：写一条新修订行，原本地历史不被覆盖；
 * - **不产生多余版本**：内容已一致时不写；
 * - 失败关闭：来源不可用／未接单／缺结单原因 ⇒ 受控原因码。
 */
describe('SyncConflictLocalViewWriterService（使用云端的本地视图对齐写入）', () => {
  const transactionContext = Object.freeze({}) as unknown as PersistenceTransactionContext;

  const makeTarget = (
    overrides: Partial<RepairRequestRevisionTargetSnapshot> = {},
  ): RepairRequestRevisionTargetSnapshot =>
    ({
      id: 11,
      requestNo: 'RQ-1',
      customerAccountId: 21,
      equipmentModelId: 31,
      errorCode: 'E-1',
      faultDescription: '客户原始描述',
      contentMd: '# 本地正文',
      intakeId: null,
      intakeServiceOrganizationId: null,
      serviceOrganizationId: 4,
      ownerOrganizationId: 4,
      createdAt: new Date('2026-11-20T00:00:00.000Z'),
      deprecated: false,
      isAccepted: true,
      acceptedByEngineerAccountId: 22,
      acceptedAt: new Date('2026-11-20T01:00:00.000Z'),
      handlingResult: null,
      handlingStatus: null,
      handlingRecordedAt: null,
      handlingRecordedByAccountId: null,
      handlingEndedAt: null,
      closureStatus: 'OPEN',
      closedAt: null,
      closureReason: null,
      handlingEndedAtLocal: undefined,
      currentRevisionNo: 4,
      maintenanceDate: null,
      maintenanceEngineerName: null,
      resetResult: null,
      supplementaryNote: null,
      maintenanceVersionNo: 0,
      maintenanceAttachmentFileId: null,
      ...overrides,
    }) as RepairRequestRevisionTargetSnapshot;

  const makeCommand = (
    overrides: Partial<SyncConflictLocalViewWriteCommand> = {},
  ): SyncConflictLocalViewWriteCommand => ({
    organizationId: 4,
    recordId: 11,
    payload: {
      resourceType: 'REPAIR_REQUEST',
      expectedVersion: 4,
      contentMd: '# 云端正文',
      handlingResult: null,
      handlingStatus: null,
    },
    actorAccountId: 900101,
    reason: '同步冲突裁决：采用云端版本（冲突 c-1）',
    ...overrides,
  });

  const makeWriter = (target: RepairRequestRevisionTargetSnapshot | null) => {
    const revisionService = {
      lockRequestForRevision: jest.fn(() => Promise.resolve(target)),
      lockProcessEntriesForRevision: jest.fn(() => Promise.resolve([])),
      listResponsesForSnapshot: jest.fn(() => Promise.resolve([])),
      lockMaintenanceSteps: jest.fn(() => Promise.resolve([])),
      lockMaintenancePanels: jest.fn(() => Promise.resolve([])),
      updateRequestRevisionFields: jest.fn(() => Promise.resolve(1)),
      insertRevision: jest.fn(() =>
        Promise.resolve({
          revisionNo: 5,
          previousVersion: 4,
          reason: 'r',
          actorAccountId: 900101,
          createdAt: new Date(),
        }),
      ),
    };
    const documentRevisionService = {
      lockDocumentForRevision: jest.fn(() => Promise.resolve(null)),
      advanceCurrentRevision: jest.fn(() => Promise.resolve('ADVANCED' as const)),
      insertRevision: jest.fn(() => Promise.resolve(undefined)),
    };
    const documentEffectiveContentService = {
      resolveEffectiveContentText: jest.fn(() => Promise.resolve(null)),
    };
    return {
      writer: new SyncConflictLocalViewWriterService(
        revisionService as unknown as RepairRequestRevisionService,
        documentRevisionService as unknown as ReferenceDocumentRevisionService,
        documentEffectiveContentService as unknown as ReferenceDocumentEffectiveContentService,
      ),
      revisionService,
      documentRevisionService,
      documentEffectiveContentService,
    };
  };

  it('内容与云端不同时：写一次受控修订并推进版本（历史只追加）', async () => {
    const { writer, revisionService } = makeWriter(makeTarget());

    const outcome = await writer.alignLocalViewToCloud(makeCommand(), transactionContext);

    expect(outcome).toEqual({ aligned: true, alignedVersion: 5 });
    expect(revisionService.updateRequestRevisionFields).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 11,
        expectedVersion: 4,
        nextVersion: 5,
        contentMd: '# 云端正文',
      }),
      transactionContext,
    );
    expect(revisionService.insertRevision).toHaveBeenCalledTimes(1);
    const inserted = (
      revisionService.insertRevision.mock.calls[0] as unknown as [
        {
          revisionNo: number;
          previousVersion: number;
          actorAccountId: number;
          reason: string;
          beforeSnapshot: string;
          afterSnapshot: string;
        },
        PersistenceTransactionContext,
      ]
    )[0];
    expect(inserted.revisionNo).toBe(5);
    expect(inserted.previousVersion).toBe(4);
    expect(inserted.actorAccountId).toBe(900101);
    // 前快照保留原本地正文（原本地冲突副本不被覆盖）
    expect(inserted.beforeSnapshot).toContain('# 本地正文');
    expect(inserted.afterSnapshot).toContain('# 云端正文');
  });

  it('云端内容与本地已一致：不产生多余业务版本', async () => {
    const { writer, revisionService } = makeWriter(makeTarget());

    const outcome = await writer.alignLocalViewToCloud(
      makeCommand({
        payload: {
          resourceType: 'REPAIR_REQUEST',
          expectedVersion: 4,
          contentMd: '# 本地正文',
          handlingResult: null,
          handlingStatus: null,
        },
      }),
      transactionContext,
    );

    expect(outcome).toEqual({ aligned: false, alignedVersion: 4 });
    expect(revisionService.updateRequestRevisionFields).not.toHaveBeenCalled();
    expect(revisionService.insertRevision).not.toHaveBeenCalled();
  });

  it('版本条件不成立：拒绝，不覆盖别人的推进', async () => {
    const { writer, revisionService } = makeWriter(makeTarget({ currentRevisionNo: 9 }));

    await expect(
      writer.alignLocalViewToCloud(makeCommand(), transactionContext),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_VERSION_STALE });
    expect(revisionService.updateRequestRevisionFields).not.toHaveBeenCalled();
  });

  it('来源记录不存在或已撤回：拒绝', async () => {
    const { writer } = makeWriter(null);

    await expect(
      writer.alignLocalViewToCloud(makeCommand(), transactionContext),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_NOT_FOUND });
  });

  it('条件更新命中 0 行：按版本冲突拒绝', async () => {
    const { writer, revisionService } = makeWriter(makeTarget());
    revisionService.updateRequestRevisionFields.mockResolvedValue(0);

    await expect(
      writer.alignLocalViewToCloud(makeCommand(), transactionContext),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_VERSION_STALE });
  });

  it('未接单的工单不能对齐云端处理结果（库级 CHECK 不允许）', async () => {
    const { writer, revisionService } = makeWriter(
      makeTarget({ isAccepted: false, acceptedByEngineerAccountId: null, acceptedAt: null }),
    );

    await expect(
      writer.alignLocalViewToCloud(
        makeCommand({
          payload: {
            resourceType: 'REPAIR_REQUEST',
            expectedVersion: 4,
            contentMd: null,
            handlingResult: RepairRequestHandlingResult.FIXED,
            handlingStatus: RepairRequestHandlingStatus.COMPLETED,
          },
        }),
        transactionContext,
      ),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CLOUD_ALIGNMENT_FAILED });
    expect(revisionService.updateRequestRevisionFields).not.toHaveBeenCalled();
  });

  it('云端结果需要结单原因而本地没有：不凭空补写', async () => {
    const { writer, revisionService } = makeWriter(makeTarget());

    await expect(
      writer.alignLocalViewToCloud(
        makeCommand({
          payload: {
            resourceType: 'REPAIR_REQUEST',
            expectedVersion: 4,
            contentMd: null,
            handlingResult: RepairRequestHandlingResult.UNREPAIRABLE,
            handlingStatus: RepairRequestHandlingStatus.UNRESOLVED,
          },
        }),
        transactionContext,
      ),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CLOUD_ALIGNMENT_FAILED });
    expect(revisionService.updateRequestRevisionFields).not.toHaveBeenCalled();
  });

  it('资源类型没有受控对齐入口：拒绝', async () => {
    const { writer } = makeWriter(makeTarget());

    await expect(
      writer.alignLocalViewToCloud(
        makeCommand({
          payload: {
            resourceType: 'MAINTENANCE_REPORT' as never,
            expectedVersion: 4,
            contentMd: '# 云端正文',
            handlingResult: null,
            handlingStatus: null,
          },
        }),
        transactionContext,
      ),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CLOUD_ALIGNMENT_RESOURCE_UNSUPPORTED });
  });

  it('实现的受支持资源类型与端口契约一致', () => {
    const { writer } = makeWriter(makeTarget());

    expect((writer as SyncConflictLocalViewWriter).supportedResourceTypes).toEqual([
      'REPAIR_REQUEST',
      'REFERENCE_DOCUMENT',
    ]);
  });
});

/**
 * 资料（REFERENCE_DOCUMENT）的本地视图对齐（R068）。
 *
 * 守住：
 * - 受控白名单：只写标题／说明／资料自身正文；
 * - 版本条件：命中条件才写，条件不成立即版本冲突；
 * - 历史只追加：写一条新修订行，原本地历史不被覆盖；
 * - 不产生多余版本：内容已一致时不写；
 * - 只读来源（下架／归属待确认）不得反写。
 */
describe('SyncConflictLocalViewWriterService（资料的本地视图对齐）', () => {
  const transactionContext = Object.freeze({}) as unknown as PersistenceTransactionContext;

  const makeDocumentTarget = (
    overrides: Partial<ReferenceDocumentRevisionTargetSnapshot> = {},
  ): ReferenceDocumentRevisionTargetSnapshot => ({
    id: 77,
    title: '本地标题',
    documentType: 'MANUAL',
    description: '本地说明',
    contentText: '# 本地正文',
    publicationStatus: 'ONLINE',
    ownershipStatus: 'CONFIRMED',
    ownerOrganizationId: 4,
    createdByAccountId: 21,
    schemaVersion: 1,
    currentRevisionNo: 2,
    deprecated: false,
    sourceKind: 'MATERIAL',
    sourceReportId: null,
    sourceReportVersionId: null,
    ...overrides,
  });

  const makeDocumentCommand = (
    overrides: Partial<SyncConflictLocalViewWriteCommand> = {},
  ): SyncConflictLocalViewWriteCommand => ({
    organizationId: 4,
    recordId: 77,
    payload: {
      resourceType: 'REFERENCE_DOCUMENT',
      expectedVersion: 2,
      title: '云端标题',
      description: null,
      contentText: '# 云端正文',
    },
    actorAccountId: 900101,
    reason: '同步冲突裁决：采用云端版本（冲突 c-2）',
    ...overrides,
  });

  const makeDocumentWriter = (
    target: ReferenceDocumentRevisionTargetSnapshot | null,
    effectiveContentText: string | null = '# 本地正文',
  ) => {
    const revisionService = {
      lockRequestForRevision: jest.fn(() => Promise.resolve(null)),
    };
    const documentRevisionService = {
      lockDocumentForRevision: jest.fn(() => Promise.resolve(target)),
      advanceCurrentRevision: jest.fn((): Promise<'ADVANCED' | 'VERSION_CONFLICT' | 'NOT_FOUND'> =>
        Promise.resolve('ADVANCED'),
      ),
      insertRevision: jest.fn(() => Promise.resolve(undefined)),
    };
    const documentEffectiveContentService = {
      resolveEffectiveContentText: jest.fn(() => Promise.resolve(effectiveContentText)),
    };
    return {
      writer: new SyncConflictLocalViewWriterService(
        revisionService as unknown as RepairRequestRevisionService,
        documentRevisionService as unknown as ReferenceDocumentRevisionService,
        documentEffectiveContentService as unknown as ReferenceDocumentEffectiveContentService,
      ),
      documentRevisionService,
      documentEffectiveContentService,
    };
  };

  it('内容与云端不同时：按版本条件写一次受控修订并追加历史', async () => {
    const { writer, documentRevisionService } = makeDocumentWriter(makeDocumentTarget());

    const outcome = await writer.alignLocalViewToCloud(makeDocumentCommand(), transactionContext);

    expect(outcome).toEqual({ aligned: true, alignedVersion: 3 });
    expect(documentRevisionService.advanceCurrentRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 77,
        expectedRevisionNo: 2,
        apply: expect.objectContaining({
          title: '云端标题',
          description: '本地说明',
          contentText: '# 云端正文',
          updatedByAccountId: 900101,
        }),
      }),
      transactionContext,
    );
    expect(documentRevisionService.insertRevision).toHaveBeenCalledTimes(1);
    const inserted = (
      documentRevisionService.insertRevision.mock.calls[0] as unknown as [
        {
          revisionNo: number;
          actorAccountId: number;
          reason: string;
          beforeSnapshot: string;
          afterSnapshot: string;
        },
        PersistenceTransactionContext,
      ]
    )[0];
    expect(inserted.revisionNo).toBe(3);
    expect(inserted.actorAccountId).toBe(900101);
    // 前快照保留原本地内容（原本地冲突副本不被覆盖）
    expect(inserted.beforeSnapshot).toContain('# 本地正文');
    expect(inserted.afterSnapshot).toContain('# 云端正文');
  });

  it('云端内容与本地已一致：不产生多余业务版本', async () => {
    const { writer, documentRevisionService } = makeDocumentWriter(makeDocumentTarget());

    const outcome = await writer.alignLocalViewToCloud(
      makeDocumentCommand({
        payload: {
          resourceType: 'REFERENCE_DOCUMENT',
          expectedVersion: 2,
          title: '本地标题',
          description: '本地说明',
          contentText: '# 本地正文',
        },
      }),
      transactionContext,
    );

    expect(outcome).toEqual({ aligned: false, alignedVersion: 2 });
    expect(documentRevisionService.advanceCurrentRevision).not.toHaveBeenCalled();
    expect(documentRevisionService.insertRevision).not.toHaveBeenCalled();
  });

  it('版本条件不成立：拒绝，不覆盖别人的推进', async () => {
    const { writer, documentRevisionService } = makeDocumentWriter(
      makeDocumentTarget({ currentRevisionNo: 9 }),
    );

    await expect(
      writer.alignLocalViewToCloud(makeDocumentCommand(), transactionContext),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_VERSION_STALE });
    expect(documentRevisionService.advanceCurrentRevision).not.toHaveBeenCalled();
  });

  it('条件更新未命中：按版本冲突拒绝', async () => {
    const { writer, documentRevisionService } = makeDocumentWriter(makeDocumentTarget());
    documentRevisionService.advanceCurrentRevision.mockResolvedValue('VERSION_CONFLICT');

    await expect(
      writer.alignLocalViewToCloud(makeDocumentCommand(), transactionContext),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_VERSION_STALE });
  });

  it('来源记录不存在或已软删：拒绝', async () => {
    const { writer } = makeDocumentWriter(null);

    await expect(
      writer.alignLocalViewToCloud(makeDocumentCommand(), transactionContext),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_NOT_FOUND });
  });

  it('下架（只读来源）不得反写：拒绝', async () => {
    const { writer, documentRevisionService } = makeDocumentWriter(
      makeDocumentTarget({ publicationStatus: 'OFFLINE' }),
    );

    await expect(
      writer.alignLocalViewToCloud(makeDocumentCommand(), transactionContext),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_SOURCE_READ_ONLY });
    expect(documentRevisionService.advanceCurrentRevision).not.toHaveBeenCalled();
  });

  it('归属待确认（冻结）不得反写：拒绝', async () => {
    const { writer, documentRevisionService } = makeDocumentWriter(
      makeDocumentTarget({ ownershipStatus: 'PENDING' }),
    );

    await expect(
      writer.alignLocalViewToCloud(makeDocumentCommand(), transactionContext),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_SOURCE_READ_ONLY });
    expect(documentRevisionService.advanceCurrentRevision).not.toHaveBeenCalled();
  });

  it('只改标题时：后快照沿用对齐前的生效正文（不丢冻结报告正文）', async () => {
    const { writer, documentRevisionService } = makeDocumentWriter(
      makeDocumentTarget({ contentText: null }),
      '冻结报告拼装正文',
    );

    await writer.alignLocalViewToCloud(
      makeDocumentCommand({
        payload: {
          resourceType: 'REFERENCE_DOCUMENT',
          expectedVersion: 2,
          title: '云端标题',
          description: null,
          contentText: null,
        },
      }),
      transactionContext,
    );

    const inserted = (
      documentRevisionService.insertRevision.mock.calls[0] as unknown as [
        { afterSnapshot: string },
        PersistenceTransactionContext,
      ]
    )[0];
    expect(inserted.afterSnapshot).toContain('冻结报告拼装正文');
  });
});
