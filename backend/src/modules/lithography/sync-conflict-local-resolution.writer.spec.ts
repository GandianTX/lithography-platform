/// <reference types="jest" />
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { SYNC_ERROR } from '@core/common/errors/domain-error';
import type { ReferenceDocumentEffectiveContentService } from '@src/modules/lithography/reference-document-effective-content.service';
import type { ReferenceDocumentRevisionService } from '@src/modules/lithography/reference-document-revision.service';
import { SyncConflictLocalResolutionWriterService } from './sync-conflict-local-resolution.writer';

/**
 * 「保留本地」的来源域受控写入实现（任务 09 第 05 项 · P1-5／G10）。
 *
 * 守住：
 * - 只写受控白名单字段（标题／说明），**正文不反写**（冻结报告正文不得被覆盖）；
 * - 版本条件命中才写，命中 0 行即版本冲突（不覆盖别人的推进）；
 * - 只读来源（下架／归属待确认）与不可用来源受控拒绝；
 * - 历史只追加：写一条新的修订历史行（前后快照＋修改人＋原因）。
 */
describe('SyncConflictLocalResolutionWriterService（保留本地·资料受控写入）', () => {
  const transactionContext = {} as PersistenceTransactionContext;

  const buildTarget = (overrides: Record<string, unknown> = {}) => ({
    id: 990001,
    title: '本地资料标题',
    documentType: 'MANUAL',
    description: '本地说明',
    contentText: '资料自身正文',
    publicationStatus: 'ONLINE',
    ownershipStatus: 'CONFIRMED',
    ownerOrganizationId: 4,
    createdByAccountId: 900101,
    schemaVersion: 1,
    currentRevisionNo: 3,
    deprecated: false,
    sourceKind: 'MANUAL',
    sourceReportId: null,
    sourceReportVersionId: null,
    ...overrides,
  });

  const createHarness = (options: {
    target?: Record<string, unknown> | null;
    effectiveContentText?: string;
    advanceOutcome?: 'ADVANCED' | 'NOT_FOUND' | 'VERSION_CONFLICT';
  }) => {
    const target = options.target === undefined ? buildTarget() : options.target;
    const documentRevisionService = {
      lockDocumentForRevision: jest.fn().mockResolvedValue(target),
      advanceCurrentRevision: jest.fn().mockResolvedValue(options.advanceOutcome ?? 'ADVANCED'),
      insertRevision: jest.fn().mockResolvedValue(undefined),
    };
    const documentEffectiveContentService = {
      resolveEffectiveContentText: jest
        .fn()
        .mockResolvedValue(options.effectiveContentText ?? '冻结报告正文'),
    };
    const writer = new SyncConflictLocalResolutionWriterService(
      documentRevisionService as unknown as ReferenceDocumentRevisionService,
      documentEffectiveContentService as unknown as ReferenceDocumentEffectiveContentService,
    );
    return {
      writer,
      documentRevisionService,
      documentEffectiveContentService,
    };
  };

  const baseCommand = {
    recordId: 990001,
    expectedVersion: 3,
    payload: {
      resourceType: 'REFERENCE_DOCUMENT' as const,
      expectedVersion: 3,
      reason: '同步冲突裁决：保留本地版本',
      title: '本地资料标题',
      description: '本地说明',
    },
    actorAccountId: 900101,
    reason: '同步冲突裁决：保留本地版本（冲突 c-doc-1）',
  };

  it('写入受控字段并追加修订历史行：版本推进 ＋ 正文不反写', async () => {
    const { writer, documentRevisionService } = createHarness({});

    const outcome = await writer.writeLocalVersion(baseCommand, transactionContext);

    expect(outcome).toEqual({ written: true, writtenVersion: 4 });
    // 版本条件 ＋ 只写标题／说明（不传 contentText ⇒ 资料正文不被覆盖）
    expect(documentRevisionService.advanceCurrentRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 990001,
        expectedRevisionNo: 3,
        apply: expect.objectContaining({
          title: '本地资料标题',
          description: '本地说明',
          updatedByAccountId: 900101,
        }),
      }),
      transactionContext,
    );
    const apply = documentRevisionService.advanceCurrentRevision.mock.calls[0][0].apply as {
      contentText?: string;
    };
    expect(apply.contentText).toBeUndefined();

    // 修订历史行：前后快照都沿用**当前生效正文**（冻结报告正文不被换成自身正文）
    const revision = documentRevisionService.insertRevision.mock.calls[0][0] as {
      revisionNo: number;
      beforeSnapshot: string;
      afterSnapshot: string;
      actorAccountId: number;
      reason: string;
    };
    expect(revision.revisionNo).toBe(4);
    expect(revision.actorAccountId).toBe(900101);
    expect(revision.reason).toBe('同步冲突裁决：保留本地版本（冲突 c-doc-1）');
    const before = JSON.parse(revision.beforeSnapshot) as { contentText: string };
    const after = JSON.parse(revision.afterSnapshot) as { contentText: string };
    expect(before.contentText).toBe('冻结报告正文');
    expect(after.contentText).toBe('冻结报告正文');
  });

  it('来源记录不可用（不存在／已软删）时受控拒绝', async () => {
    for (const target of [null, buildTarget({ deprecated: true })]) {
      const { writer, documentRevisionService } = createHarness({ target });
      await expect(writer.writeLocalVersion(baseCommand, transactionContext)).rejects.toMatchObject(
        { code: SYNC_ERROR.CONFLICT_NOT_FOUND },
      );
      expect(documentRevisionService.advanceCurrentRevision).not.toHaveBeenCalled();
    }
  });

  it('只读来源（下架／归属待确认）受控拒绝，不写回内容', async () => {
    for (const target of [
      buildTarget({ publicationStatus: 'OFFLINE' }),
      buildTarget({ ownershipStatus: 'PENDING' }),
    ]) {
      const { writer, documentRevisionService } = createHarness({ target });
      await expect(writer.writeLocalVersion(baseCommand, transactionContext)).rejects.toMatchObject(
        { code: SYNC_ERROR.CONFLICT_SOURCE_READ_ONLY },
      );
      expect(documentRevisionService.advanceCurrentRevision).not.toHaveBeenCalled();
      expect(documentRevisionService.insertRevision).not.toHaveBeenCalled();
    }
  });

  it('来源版本已被推进时受控拒绝（版本条件不成立）', async () => {
    const { writer, documentRevisionService } = createHarness({
      target: buildTarget({ currentRevisionNo: 5 }),
    });

    await expect(writer.writeLocalVersion(baseCommand, transactionContext)).rejects.toMatchObject({
      code: SYNC_ERROR.CONFLICT_VERSION_STALE,
    });
    expect(documentRevisionService.advanceCurrentRevision).not.toHaveBeenCalled();
  });

  it('条件更新未命中时按版本冲突／记录不可用分别受控拒绝', async () => {
    const stale = createHarness({ advanceOutcome: 'VERSION_CONFLICT' });
    await expect(
      stale.writer.writeLocalVersion(baseCommand, transactionContext),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_VERSION_STALE });
    expect(stale.documentRevisionService.insertRevision).not.toHaveBeenCalled();

    const missing = createHarness({ advanceOutcome: 'NOT_FOUND' });
    await expect(
      missing.writer.writeLocalVersion(baseCommand, transactionContext),
    ).rejects.toMatchObject({ code: SYNC_ERROR.CONFLICT_NOT_FOUND });
    expect(missing.documentRevisionService.insertRevision).not.toHaveBeenCalled();
  });

  it('不受支持的资源类型受控拒绝（不写任何事实）', async () => {
    const { writer, documentRevisionService } = createHarness({});

    await expect(
      writer.writeLocalVersion(
        {
          ...baseCommand,
          payload: {
            resourceType: 'REPAIR_REQUEST',
            expectedVersion: 3,
            reason: '同步冲突裁决：保留本地版本',
          },
        } as unknown as typeof baseCommand,
        transactionContext,
      ),
    ).rejects.toMatchObject({ code: SYNC_ERROR.LOCAL_RESOLUTION_RESOURCE_UNSUPPORTED });
    expect(documentRevisionService.advanceCurrentRevision).not.toHaveBeenCalled();
    expect(documentRevisionService.insertRevision).not.toHaveBeenCalled();
  });
});
